#!/usr/bin/env python3
"""Unit tests for scripts/verification/model-impact.py.

Each test builds a tiny synthetic repository (Rust sources, fake verification
registration scripts, a manifest, and the generated docs block) so the checker
is exercised on the failure modes that matter: missing artifacts, stale
residual reviews, expired waivers, advisory symbols, and a non-stable render.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import sys
from pathlib import Path

import pytest

scripts_dir = Path(__file__).parent.parent
spec = importlib.util.spec_from_file_location(
    "model_impact",
    scripts_dir / "verification" / "model-impact.py",
)
model_impact = importlib.util.module_from_spec(spec)
sys.modules["model_impact"] = model_impact
spec.loader.exec_module(model_impact)

TODAY = dt.date.today()
FUTURE = (TODAY + dt.timedelta(days=90)).isoformat()
PAST = "2000-01-01"


def _manifest(
    *,
    specs: str = '["specs/tla/Demo.tla"]',
    kani: str = '["proof_demo"]',
    z3: str = '["z3_proof_demo"]',
    tests: str = '["demo::tests::demo_test"]',
    residual: str = "",
    waiver: str = "",
) -> str:
    return f"""schema_version = 1

[[component]]
id = "demo"
status = "modeled"
owner = "maintainer"
last_reviewed = "{TODAY.isoformat()}"
paths = ["src/demo.rs", "src/other.rs"]
symbols = ["src/demo.rs::mapped_fn"]
specs = {specs}
kani = {kani}
z3 = {z3}
tests = {tests}
scope = "fixture"
residuals = [{residual}]

{waiver}
"""


def build_repo(tmp_path: Path, manifest: str | None = None) -> Path:
    """Create a consistent synthetic repository."""
    repo = tmp_path / "repo"
    for directory in (
        "src",
        "specs/tla",
        "scripts/verification",
        "tests/verification",
        "docs/specs",
    ):
        (repo / directory).mkdir(parents=True)
    (repo / "src" / "demo.rs").write_text(
        "pub fn mapped_fn() -> u32 {\n    1\n}\n\n"
        "#[cfg(test)]\nmod tests {\n    #[test]\n"
        "    fn demo_test() {\n        assert_eq!(super::mapped_fn(), 1);\n    }\n}\n",
        encoding="utf-8",
    )
    (repo / "src" / "other.rs").write_text("pub fn other() {}\n", encoding="utf-8")
    (repo / "specs" / "tla" / "Demo.tla").write_text(
        "---- MODULE Demo ----\n====\n", encoding="utf-8"
    )
    (repo / "scripts" / "verification" / "verify-tla.sh").write_text(
        '#!/bin/bash\nSPECS=(\n    "Demo"\n)\n'
        "EXPECTED_FAILURE_CHECKS=()\nADDITIONAL_CHECKS=()\nTRACE_CHECKS=()\n",
        encoding="utf-8",
    )
    (repo / "scripts" / "verification" / "verify-kani.sh").write_text(
        '#!/bin/bash\nTIER1_PROOFS=(\n    "proof_demo"\n)\n'
        "TIER2_PROOFS=()\nTIER3_PROOFS=()\n",
        encoding="utf-8",
    )
    (repo / "tests" / "verification" / "z3.rs").write_text(
        "fn z3_proof_demo() {}\n", encoding="utf-8"
    )
    (repo / "docs" / "specs" / "verification-manifest.toml").write_text(
        manifest if manifest is not None else _manifest(), encoding="utf-8"
    )
    (repo / "docs" / "specs" / "spec-divergences.md").write_text(
        f"# Divergences\n\n{model_impact.BEGIN_MARKER}\n{model_impact.END_MARKER}\n",
        encoding="utf-8",
    )
    parsed = model_impact.load_manifest(repo / model_impact.MANIFEST_REL)
    model_impact.write_render(parsed, repo)
    return repo


def run_check(repo: Path) -> model_impact.Report:
    return model_impact.check_manifest(
        model_impact.load_manifest(repo / model_impact.MANIFEST_REL), repo
    )


# --- check: valid baseline -------------------------------------------------


def test_complete_manifest_passes(tmp_path: Path) -> None:
    report = run_check(build_repo(tmp_path))
    assert report.errors == [], report.errors
    assert report.warnings == []


def test_missing_mapped_path_fails_closed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest().replace("src/other.rs", "src/missing.rs"))
    assert any("mapped path does not exist: src/missing.rs" in error for error in run_check(repo).errors)


# --- check: missing artifacts fail closed ----------------------------------


def test_missing_spec_fails_closed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(specs='["specs/tla/Missing.tla"]'))
    assert any("TLA spec does not exist" in error for error in run_check(repo).errors)


def test_unregistered_kani_harness_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(kani='["proof_missing"]'))
    assert any("Kani harness 'proof_missing' is not registered" in error for error in run_check(repo).errors)


def test_missing_rust_test_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(tests='["demo::tests::missing_test"]'))
    assert any("has no definition" in error for error in run_check(repo).errors)


def test_missing_z3_proof_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(z3='["z3_proof_missing"]'))
    assert any("is not defined in tests/verification/z3.rs" in error for error in run_check(repo).errors)


def test_unregistered_tla_check_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / "scripts" / "verification" / "verify-tla.sh").write_text(
        '#!/bin/bash\nSPECS=(\n    "Other"\n)\n', encoding="utf-8"
    )
    assert any("is not registered in scripts/verification/verify-tla.sh" in error for error in run_check(repo).errors)


# --- check: stale dates and waivers ----------------------------------------


def test_stale_residual_review_by_fails(tmp_path: Path) -> None:
    residual = f'{{ id = "gap", description = "known gap", review_by = "{PAST}" }}'
    repo = build_repo(tmp_path, _manifest(residual=residual))
    assert any("has expired" in error for error in run_check(repo).errors)


def test_expired_waiver_fails_check(tmp_path: Path) -> None:
    waiver = (
        '[[waiver]]\ncomponent = "demo"\nreason = "fixture"\n'
        f'approver = "named-maintainer"\nexpires = "{PAST}"\n'
    )
    repo = build_repo(tmp_path, _manifest(waiver=waiver))
    assert any("expired on" in error for error in run_check(repo).errors)


# --- check: symbol regex is advisory ---------------------------------------


def test_unknown_symbol_warns_but_does_not_fail(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest().replace("mapped_fn", "not_a_symbol"))
    report = run_check(repo)
    assert report.errors == [], report.errors
    assert any("advisory" in warning for warning in report.warnings)


# --- render: stable and checked --------------------------------------------


def test_render_is_stable_and_check_matches(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    manifest = model_impact.load_manifest(repo / model_impact.MANIFEST_REL)
    assert model_impact.write_render(manifest, repo) is False
    assert run_check(repo).errors == []

    docs = repo / model_impact.DIVERGENCES_REL
    docs.write_text(docs.read_text(encoding="utf-8").replace("| modeled |", "| stale |"), encoding="utf-8")
    assert any("stale" in error for error in run_check(repo).errors)


def test_render_block_is_deterministic(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    manifest = model_impact.load_manifest(repo / model_impact.MANIFEST_REL)
    assert model_impact.render_block(manifest) == model_impact.render_block(manifest)
    block = model_impact.render_block(manifest)
    assert model_impact.BEGIN_MARKER in block
    assert model_impact.END_MARKER in block
    assert "| `demo` | modeled |" in block


# --- CLI smoke -------------------------------------------------------------


def test_cli_check_returns_zero(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    repo = build_repo(tmp_path)
    assert model_impact.main(["check", "--root", str(repo)]) == 0
    assert "model-impact check: OK" in capsys.readouterr().out
