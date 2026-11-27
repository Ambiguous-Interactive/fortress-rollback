#!/usr/bin/env python3
"""Unit tests for scripts/verification/model-impact.py.

Each test builds a tiny synthetic repository (Rust sources, fake verification
registration scripts, a manifest, and the generated docs block) so the checker
is exercised on the failure modes that matter: missing artifacts, stale
residual reviews, code drift without a model/proof update, waivers, and a
non-stable render.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import subprocess
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
    status: str = "modeled",
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
status = "{status}"
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

[z3_proof_strength]
code_linked = []
model_only = ["z3_proof_demo"]
witness_only = []
tautology = []
"""


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def build_repo(
    tmp_path: Path, manifest: str | None = None, subdir: str | None = None
) -> Path:
    """Create a consistent synthetic repository and commit it.

    When *subdir* is set the project lives below the Git root, so a run with
    ``--root`` pointing at the project exercises the repository-prefix path.
    """
    repository = tmp_path / "repo"
    repo = repository / subdir if subdir else repository
    (repo / "src").mkdir(parents=True)
    (repo / "specs" / "tla").mkdir(parents=True)
    (repo / "scripts" / "verification").mkdir(parents=True)
    (repo / "tests" / "verification").mkdir(parents=True)
    (repo / "docs" / "specs").mkdir(parents=True)

    (repo / "src" / "demo.rs").write_text(
        "pub fn mapped_fn() -> u32 {\n    1\n}\n\n"
        "#[kani::proof]\n"
        "fn proof_demo() {\n"
        "    assert!(true);\n"
        "}\n\n"
        "#[cfg(test)]\nmod tests {\n"
        "    #[test]\n"
        "    fn demo_test() {\n"
        "        assert_eq!(super::mapped_fn(), 1);\n"
        "    }\n"
        "}\n",
        encoding="utf-8",
    )
    (repo / "src" / "other.rs").write_text("pub fn other() {}\n", encoding="utf-8")
    (repo / "specs" / "tla" / "Demo.tla").write_text(
        "---- MODULE Demo ----\n====\n", encoding="utf-8"
    )
    (repo / "scripts" / "verification" / "verify-tla.sh").write_text(
        '#!/bin/bash\nSPECS=(\n    "Demo"\n)\n'
        "EXPECTED_FAILURE_CHECKS=()\n"
        "ADDITIONAL_CHECKS=()\n"
        "TRACE_CHECKS=()\n",
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
    (repo / "Cargo.toml").write_text(
        '[package]\nname = "fixture"\nversion = "0.1.0"\n', encoding="utf-8"
    )
    manifest_text = manifest if manifest is not None else _manifest()
    (repo / "docs" / "specs" / "verification-manifest.toml").write_text(
        manifest_text, encoding="utf-8"
    )
    (repo / "docs" / "specs" / "spec-divergences.md").write_text(
        "# Divergences\n\n"
        f"{model_impact.BEGIN_MARKER}\n"
        f"{model_impact.END_MARKER}\n",
        encoding="utf-8",
    )

    _git(repository, "init", "-q")
    _git(repository, "config", "user.name", "Fixture")
    _git(repository, "config", "user.email", "fixture@example.invalid")
    _git(repository, "add", ".")
    _git(repository, "commit", "-q", "-m", "fixture baseline")

    # The generated block must match the committed manifest.
    parsed = model_impact.load_manifest(repo / model_impact.MANIFEST_REL)
    model_impact.write_render(parsed, repo)
    _git(repository, "add", ".")
    _git(repository, "commit", "-q", "-m", "render fixture table")
    return repo


def run_check(repo: Path) -> model_impact.Report:
    manifest = model_impact.load_manifest(repo / model_impact.MANIFEST_REL)
    return model_impact.check_manifest(manifest, repo)


def run_affected(repo: Path) -> model_impact.ImpactReport:
    manifest = model_impact.load_manifest(repo / model_impact.MANIFEST_REL)
    return model_impact.affected_components(manifest, repo, base="HEAD")


# --- check: valid baseline -------------------------------------------------


def test_complete_manifest_passes(tmp_path: Path) -> None:
    report = run_check(build_repo(tmp_path))
    assert report.errors == [], report.errors
    assert report.warnings == []


def test_missing_mapped_path_fails_closed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest().replace("src/other.rs", "src/missing.rs"))
    report = run_check(repo)
    assert any("mapped path does not exist: src/missing.rs" in error for error in report.errors)


# --- check: missing artifacts fail closed ----------------------------------


def test_missing_spec_fails_closed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(specs='["specs/tla/Missing.tla"]'))
    report = run_check(repo)
    assert any("TLA spec does not exist" in error for error in report.errors)


def test_unregistered_kani_harness_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(kani='["proof_missing"]'))
    report = run_check(repo)
    assert any("Kani harness 'proof_missing' is not registered" in error for error in report.errors)


def test_missing_kani_harness_definition_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(
        demo.read_text(encoding="utf-8").replace(
            "#[kani::proof]\nfn proof_demo() {\n    assert!(true);\n}\n\n", ""
        ),
        encoding="utf-8",
    )
    report = run_check(repo)
    assert any("has no #[kani::proof] definition" in error for error in report.errors)


def test_duplicate_kani_harness_definition_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / "src" / "other_proof.rs").write_text(
        "#[kani::proof]\nfn proof_demo() {}\n", encoding="utf-8"
    )
    report = run_check(repo)
    assert any("defined in multiple files" in error for error in report.errors)


def test_missing_rust_test_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(tests='["demo::tests::missing_test"]'))
    report = run_check(repo)
    assert any("has no #[test] definition" in error for error in report.errors)


def test_mislocated_rust_test_name_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(tests='["missing::module::tests::demo_test"]'))
    report = run_check(repo)
    assert any("has no #[test] definition" in error for error in report.errors)


@pytest.mark.parametrize("name", ["tests::demo_test", "demo_test"])
def test_underqualified_rust_test_name_fails(tmp_path: Path, name: str) -> None:
    repo = build_repo(tmp_path, _manifest(tests=f'["{name}"]'))
    report = run_check(repo)
    assert any("has no #[test] definition" in error for error in report.errors)


def test_duplicate_test_name_across_files_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(tests='["collide::same_test"]'))
    for root in ("src", "tests"):
        (repo / root / "collide.rs").write_text(
            "#[test]\nfn same_test() {}\n", encoding="utf-8"
        )
    report = run_check(repo)
    assert any("defined in multiple files" in error for error in report.errors)


def test_test_index_qualifies_nested_inline_modules(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    nested = repo / "src" / "nested.rs"
    nested.write_text(
        "mod outer {\n    mod tests {\n        #[test]\n        fn nested_test() {}\n    }\n}\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert index.get("nested::outer::tests::nested_test") == (nested,)


def test_test_index_does_not_reuse_a_preceding_test_attribute(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    helpers = repo / "src" / "helpers.rs"
    helpers.write_text(
        "#[test]\nfn actual_test() {}\n\nfn helper() {}\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert "helpers::actual_test" in index
    assert "helpers::helper" not in index


def test_macro_template_fn_is_not_indexed_as_a_test(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    config = repo / "src" / "config.rs"
    config.write_text(
        "#[test]\nfn real_test() {}\n\n"
        "pastey::paste! {\n    #[test]\n    fn [<test_ $ty>]() {}\n}\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert "config::real_test" in index
    assert "config::test_" not in index


def test_macro_rules_template_is_not_indexed_as_a_test(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    macros = repo / "src" / "macros.rs"
    macros.write_text(
        "macro_rules! make_test {\n    () => {\n        #[test]\n        fn phantom() {}\n    };\n}\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert "macros::phantom" not in index


@pytest.mark.parametrize("opening,closing", [("{", "}"), ("(", ")"), ("[", "]")])
def test_macro_invocation_template_is_not_indexed_as_a_test(
    tmp_path: Path, opening: str, closing: str
) -> None:
    repo = build_repo(tmp_path)
    macros = repo / "src" / "macros.rs"
    macros.write_text(
        f"consume!{opening}#[test] fn phantom() {{{closing}}};\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert "macros::phantom" not in index


def test_same_line_test_attribute_is_indexed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    helpers = repo / "src" / "helpers.rs"
    helpers.write_text("#[test] fn same_line_test() {}\n", encoding="utf-8")
    index = model_impact.test_index(repo)
    assert "helpers::same_line_test" in index


def test_one_line_test_attribute_before_helper_does_not_leak(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    helpers = repo / "src" / "helpers.rs"
    helpers.write_text("#[test] fn actual_test() {}\n\nfn helper() {}\n", encoding="utf-8")
    index = model_impact.test_index(repo)
    assert "helpers::helper" not in index
    assert "helper" not in index


def test_multiline_attribute_block_is_indexed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    helpers = repo / "src" / "helpers.rs"
    helpers.write_text(
        "#[test]\n"
        "#[cfg_attr(\n"
        '    feature = "slow",\n'
        "    ignore\n"
        ")]\n"
        "fn attributed_test() {}\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert "helpers::attributed_test" in index


def test_multiline_attribute_block_does_not_leak_from_a_previous_item(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    helpers = repo / "src" / "helpers.rs"
    helpers.write_text(
        "#[cfg_attr(\n"
        '    feature = "slow",\n'
        "    ignore\n"
        ")]\n"
        "fn helper() {}\n\n"
        "#[test]\n"
        "fn actual_test() {}\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert "helpers::helper" not in index
    assert "helpers::actual_test" in index


def test_multiline_kani_attribute_is_indexed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(
        demo.read_text(encoding="utf-8").replace(
            "#[kani::proof]\nfn proof_demo()",
            "#[kani::proof]\n#[kani::unwind(\n    4\n)]\nfn proof_demo()",
        ),
        encoding="utf-8",
    )
    assert "proof_demo" in model_impact.kani_proof_index(repo)


@pytest.mark.parametrize(
    ("relative", "expected"),
    [
        ("src/lib.rs", ()),
        ("src/demo.rs", ("demo",)),
        ("src/bin/tool.rs", ("tool",)),
        ("src/bin/tool/main.rs", ("tool",)),
        ("src/bin/tool/helper.rs", ("tool", "helper")),
        ("src/main.rs", ("fixture",)),
        ("tests/demo.rs", ("demo",)),
        ("tests/verification/z3.rs", ("verification", "z3")),
    ],
)
def test_module_path_uses_the_cargo_target_root(
    tmp_path: Path, relative: str, expected: tuple[str, ...]
) -> None:
    repo = build_repo(tmp_path)
    assert model_impact._module_path(repo / relative, repo) == expected


def test_multiline_attribute_with_braces_is_indexed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    helpers = repo / "src" / "helpers.rs"
    helpers.write_text(
        "#[test]\n"
        "#[marker {\n"
        "    key = 1\n"
        "}]\n"
        "fn attributed_test() {}\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert "helpers::attributed_test" in index


def test_multiline_attribute_with_a_brace_in_a_string_is_indexed(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    helpers = repo / "src" / "helpers.rs"
    helpers.write_text(
        "#[test]\n"
        "#[should_panic(\n"
        '    expected = "boom {"\n'
        ")]\n"
        "fn attributed_test() {}\n",
        encoding="utf-8",
    )
    index = model_impact.test_index(repo)
    assert "helpers::attributed_test" in index


def test_module_path_uses_explicit_binary_target_names(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / "Cargo.toml").write_text(
        '[package]\nname = "fixture"\nversion = "0.1.0"\n\n'
        '[[bin]]\nname = "server"\npath = "src/main.rs"\n\n'
        '[[bin]]\nname = "renamed-tool"\npath = "src/bin/tool.rs"\n\n'
        '[[bin]]\nname = "directory-tool"\npath = "src/bin/tool/main.rs"\n',
        encoding="utf-8",
    )
    assert model_impact._module_path(repo / "src" / "main.rs", repo) == ("server",)
    assert model_impact._module_path(repo / "src" / "bin" / "tool.rs", repo) == (
        "renamed_tool",
    )
    assert model_impact._module_path(repo / "src" / "bin" / "tool" / "main.rs", repo) == (
        "directory_tool",
    )
    assert model_impact._module_path(repo / "src" / "bin" / "tool" / "helper.rs", repo) == (
        "directory_tool",
        "helper",
    )


def test_two_functions_on_one_line_bind_attributes_separately(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    helpers = repo / "src" / "helpers.rs"
    helpers.write_text("#[test] fn actual_test() {} fn helper() {}\n", encoding="utf-8")
    index = model_impact.test_index(repo)
    assert "helpers::actual_test" in index
    assert "helpers::helper" not in index


def _two_module_demo(repo: Path) -> Path:
    demo = repo / "src" / "demo.rs"
    demo.write_text(
        "pub fn mapped_fn() -> u32 {\n    1\n}\n\n"
        "#[cfg(test)]\nmod other {\n    #[test]\n    fn demo_test() {}\n}\n\n"
        "#[cfg(test)]\nmod tests {\n    #[test]\n    fn demo_test() {\n"
        "        assert_eq!(super::mapped_fn(), 1);\n    }\n}\n",
        encoding="utf-8",
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "two modules with the same test name")
    return demo


def test_same_named_test_in_another_module_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = _two_module_demo(repo)
    text = demo.read_text(encoding="utf-8").replace("    1\n", "    2\n", 1)
    demo.write_text(
        text.replace(
            "mod other {\n    #[test]\n    fn demo_test() {}",
            "mod other {\n    #[test]\n    fn demo_test() {\n        let _ = 1;\n    }",
        ),
        encoding="utf-8",
    )

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_mapped_test_body_is_compared_in_its_own_module(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = _two_module_demo(repo)
    text = demo.read_text(encoding="utf-8").replace("    1\n", "    2\n", 1)
    demo.write_text(
        text.replace(
            "assert_eq!(super::mapped_fn(), 1);",
            "assert_eq!(super::mapped_fn(), 2);",
        ),
        encoding="utf-8",
    )

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is True
    assert report.drifted == ()


def test_missing_z3_proof_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(z3='["z3_proof_missing"]'))
    report = run_check(repo)
    assert any("is not defined in tests/verification/z3.rs" in error for error in report.errors)


def test_z3_proof_strength_requires_every_test(tmp_path: Path) -> None:
    manifest = _manifest().replace(
        'model_only = ["z3_proof_demo"]', "model_only = []"
    )
    repo = build_repo(tmp_path, manifest)
    report = run_check(repo)
    assert any(
        "z3-proof-strength: missing classification for 'z3_proof_demo'" in error
        for error in report.errors
    )


def test_z3_proof_strength_detects_qualified_functions(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / "tests" / "verification" / "z3.rs").write_text(
        "fn z3_proof_demo() {}\npub async fn z3_proof_async() {}\n",
        encoding="utf-8",
    )
    report = run_check(repo)
    assert any(
        "z3-proof-strength: missing classification for 'z3_proof_async'" in error
        for error in report.errors
    )


def test_z3_proof_strength_detects_same_line_attribute(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / "tests" / "verification" / "z3.rs").write_text(
        "#[test] fn z3_proof_inline() {}\nfn z3_proof_demo() {}\n",
        encoding="utf-8",
    )
    report = run_check(repo)
    assert any(
        "z3-proof-strength: missing classification for 'z3_proof_inline'" in error
        for error in report.errors
    )


def test_z3_proof_strength_ignores_comments_and_literals(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / "tests" / "verification" / "z3.rs").write_text(
        "/* fn z3_proof_comment_fake() {} */\n"
        'const S: &str = "fn z3_proof_literal_fake() {}";\n'
        "fn z3_proof_demo() {}\n",
        encoding="utf-8",
    )
    report = run_check(repo)
    assert report.errors == [], report.errors


def test_z3_summary_total_must_match_the_source(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    manifest = _manifest().replace(
        'model_only = ["z3_proof_demo"]',
        'model_only = ["z3_proof_demo", "z3_verified_properties_summary"]',
    )
    (repo / "docs" / "specs" / "verification-manifest.toml").write_text(
        manifest, encoding="utf-8"
    )
    (repo / "tests" / "verification" / "z3.rs").write_text(
        "fn z3_proof_demo() {}\n"
        'fn z3_verified_properties_summary() {\n'
        '    println!("Total: 99 non-summary Z3 tests");\n'
        "}\n",
        encoding="utf-8",
    )
    report = run_check(repo)
    assert any(
        "summary says 99 non-summary Z3 tests, the file has 1" in error
        for error in report.errors
    )


def test_z3_proof_strength_rejects_unknown_test(tmp_path: Path) -> None:
    manifest = _manifest().replace(
        'model_only = ["z3_proof_demo"]',
        'model_only = ["z3_proof_demo", "z3_proof_ghost"]',
    )
    repo = build_repo(tmp_path, manifest)
    report = run_check(repo)
    assert any(
        "z3-proof-strength: unknown Z3 test 'z3_proof_ghost'" in error
        for error in report.errors
    )


def test_z3_proof_strength_rejects_duplicate_classification(tmp_path: Path) -> None:
    manifest = _manifest().replace(
        "witness_only = []", 'witness_only = ["z3_proof_demo"]'
    )
    repo = build_repo(tmp_path, manifest)
    report = run_check(repo)
    assert any(
        "z3-proof-strength: duplicate classification for z3_proof_demo" in error
        for error in report.errors
    )


def test_z3_proof_strength_rejects_unknown_strength() -> None:
    manifest = _manifest().replace(
        "witness_only = []", 'not_a_strength = ["z3_proof_demo"]'
    )
    with pytest.raises(model_impact.ManifestError, match="unknown keys"):
        model_impact.parse_manifest_text(manifest)


def test_z3_proof_strength_table_is_required(tmp_path: Path) -> None:
    manifest = _manifest().replace(
        "[z3_proof_strength]\n"
        "code_linked = []\n"
        'model_only = ["z3_proof_demo"]\n'
        "witness_only = []\n"
        "tautology = []\n",
        "",
    )
    repo = build_repo(tmp_path, manifest)
    report = run_check(repo)
    assert any(
        "missing [z3_proof_strength] classification table" in error
        for error in report.errors
    )


def test_code_linked_proof_must_be_mapped_to_a_component(tmp_path: Path) -> None:
    manifest = _manifest(z3="[]").replace(
        "code_linked = []", 'code_linked = ["z3_proof_demo"]'
    ).replace('model_only = ["z3_proof_demo"]', "model_only = []")
    repo = build_repo(tmp_path, manifest)
    report = run_check(repo)
    assert any(
        "code_linked proof 'z3_proof_demo' must be mapped" in error
        for error in report.errors
    )


def test_unregistered_tla_check_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / "scripts" / "verification" / "verify-tla.sh").write_text(
        '#!/bin/bash\nSPECS=(\n    "Other"\n)\n', encoding="utf-8"
    )
    report = run_check(repo)
    assert any("is not registered in scripts/verification/verify-tla.sh" in error for error in report.errors)


# --- check: stale residual review fails ------------------------------------


def test_modeled_component_without_artifacts_fails(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(specs="[]", kani="[]", z3="[]", tests="[]"))
    assert any("requires a mapped verification artifact" in error for error in run_check(repo).errors)


def test_stale_residual_review_by_fails(tmp_path: Path) -> None:
    residual = (
        '{ id = "gap", description = "known gap", '
        f'review_by = "{PAST}" }}'
    )
    repo = build_repo(tmp_path, _manifest(residual=residual))
    report = run_check(repo)
    assert any("review_by" in error and "has expired" in error for error in report.errors)


def test_missing_alignment_document_fails_check(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / model_impact.DIVERGENCES_REL).unlink()
    assert any("cannot read" in error for error in run_check(repo).errors)


def test_deletion_inside_mapped_symbol_is_flagged(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", ""), encoding="utf-8")
    report = run_affected(repo)
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_unmodeled_component_test_update_satisfies_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path, _manifest(status="unmodeled"))
    demo = repo / "src" / "demo.rs"
    text = demo.read_text(encoding="utf-8")
    demo.write_text(
        text.replace("    1\n", "    2\n").replace(
            "assert_eq!(super::mapped_fn(), 1);",
            "assert_eq!(super::mapped_fn(), 2);",
        ),
        encoding="utf-8",
    )
    report = run_affected(repo)
    assert report.drifted == ()
    assert report.impacts[0].verification_updated is True


# --- check: symbol regex is advisory ---------------------------------------


def test_unknown_symbol_warns_but_does_not_fail(tmp_path: Path) -> None:
    repo = build_repo(
        tmp_path,
        _manifest().replace("mapped_fn", "not_a_symbol"),
    )
    report = run_check(repo)
    assert report.errors == [], report.errors
    assert any("advisory" in warning for warning in report.warnings)


def test_untracked_mapped_path_is_flagged(tmp_path: Path) -> None:
    manifest = _manifest().replace('"src/other.rs"', '"src/new.rs"').replace(
        "src/demo.rs::mapped_fn", "src/new.rs::new_fn"
    )
    repo = build_repo(tmp_path, manifest)
    (repo / "src" / "new.rs").write_text("pub fn new_fn() {}\n", encoding="utf-8")
    report = run_affected(repo)
    assert any("new or untracked" in reason for reason in report.impacts[0].reasons)


# --- affected: mapped symbol drift -----------------------------------------


def test_mapped_symbol_change_without_update_is_flagged(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")

    report = run_affected(repo)
    assert [impact.component.component_id for impact in report.impacts] == ["demo"]
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]
    impact = report.impacts[0]
    assert impact.verification_updated is False
    assert "./scripts/verification/verify-tla.sh Demo" in impact.commands
    assert "cargo kani --harness proof_demo" in impact.commands
    assert "cargo test --features z3-verification --test verification z3" in impact.commands
    assert "MISSING" in model_impact.format_impact(report)


def test_test_only_change_does_not_trigger_symbol_drift(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(
        demo.read_text(encoding="utf-8").replace(
            "assert_eq!(super::mapped_fn(), 1);",
            "assert_eq!(super::mapped_fn(), 1);\n        assert!(true);",
        ),
        encoding="utf-8",
    )
    report = run_affected(repo)
    assert report.impacts == ()
    assert report.drifted == ()


@pytest.mark.parametrize(
    "body",
    [
        '    let marker = "}";\n    do_work();\n',
        "    let marker = '}';\n    do_work();\n",
        "    let marker = 1; // }\n    do_work();\n",
        "    /* } */\n    do_work();\n",
        '    let marker = r#"}"#;\n    do_work();\n',
        '    let marker = cr#"a" } b"#;\n    do_work();\n',
        "    /* outer /* } */ still */\n    do_work();\n",
        "    fn inner<'a>(value: &'a u8) -> &'a u8 { value }\n    do_work();\n",
    ],
    ids=[
        "string",
        "char",
        "line-comment",
        "block-comment",
        "raw-string",
        "c-raw-string",
        "nested-comment",
        "lifetime",
    ],
)
def test_fn_range_ignores_braces_in_literals_and_comments(body: str) -> None:
    text = f"fn mapped_fn() {{\n{body}}}\n"
    assert model_impact._fn_range_text(text, "mapped_fn") == (1, 4)


def test_string_brace_does_not_hide_a_later_mapped_change(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(
        demo.read_text(encoding="utf-8").replace(
            "pub fn mapped_fn() -> u32 {\n    1\n}",
            'pub fn mapped_fn() -> u32 {\n    let marker = "}";\n    1\n}',
        ),
        encoding="utf-8",
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "add string brace")
    demo.write_text(
        demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8"
    )

    report = run_affected(repo)
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_changed_path_without_symbol_mapping_is_flagged(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    (repo / "src" / "other.rs").write_text("pub fn other() { let _ = 1; }\n", encoding="utf-8")
    report = run_affected(repo)
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]
    assert any("mapped path" in reason for reason in report.impacts[0].reasons)


def test_active_waiver_suppresses_drift(tmp_path: Path) -> None:
    waiver = (
        "[[waiver]]\n"
        'component = "demo"\n'
        'reason = "fixture approval"\n'
        'approver = "named-maintainer"\n'
        f'expires = "{FUTURE}"\n'
    )
    repo = build_repo(tmp_path, _manifest(waiver=waiver))
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")

    report = run_affected(repo)
    assert report.drifted == ()
    assert report.impacts[0].waiver is not None
    assert "waived by named-maintainer" in model_impact.format_impact(report)


def test_expired_waiver_does_not_suppress_drift(tmp_path: Path) -> None:
    waiver = (
        "[[waiver]]\n"
        'component = "demo"\n'
        'reason = "fixture approval"\n'
        'approver = "named-maintainer"\n'
        f'expires = "{PAST}"\n'
    )
    repo = build_repo(tmp_path, _manifest(waiver=waiver))
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")

    report = run_affected(repo)
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_spec_update_in_same_diff_satisfies_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    spec = repo / "specs" / "tla" / "Demo.tla"
    spec.write_text(spec.read_text(encoding="utf-8") + "\nVARIABLE reviewed\n", encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is True
    assert report.drifted == ()


@pytest.mark.parametrize(
    "suffix",
    ["\n\\* comment-only touch\n", "\n(* comment-only touch *)\n", "\n\n   \n"],
    ids=["line-comment", "block-comment", "whitespace"],
)
def test_comment_only_spec_update_does_not_satisfy_gate(tmp_path: Path, suffix: str) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    spec = repo / "specs" / "tla" / "Demo.tla"
    spec.write_text(spec.read_text(encoding="utf-8") + suffix, encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


@pytest.mark.parametrize("body", ["\\* only a comment\n", "\n\n   \n"])
def test_new_comment_only_spec_does_not_satisfy_gate(tmp_path: Path, body: str) -> None:
    manifest = _manifest(specs='["specs/tla/Demo.tla", "specs/tla/New.tla"]')
    repo = build_repo(tmp_path, manifest)
    (repo / "specs" / "tla" / "New.tla").write_text(body, encoding="utf-8")
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_new_substantive_spec_satisfies_gate(tmp_path: Path) -> None:
    manifest = _manifest(specs='["specs/tla/Demo.tla", "specs/tla/New.tla"]')
    repo = build_repo(tmp_path, manifest)
    (repo / "specs" / "tla" / "New.tla").write_text(
        "---- MODULE New ----\nVARIABLE ticks\n====\n", encoding="utf-8"
    )
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is True
    assert report.drifted == ()


def test_internal_whitespace_spec_update_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    spec = repo / "specs" / "tla" / "Demo.tla"
    spec.write_text("---- MODULE Demo ----\nVARIABLE reviewed\n====\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "add variable")
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    spec.write_text("---- MODULE Demo ----\nVARIABLE    reviewed\n====\n", encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


# --- affected: repository prefix under a subdirectory root ------------------


def test_comment_only_spec_update_under_a_subdirectory_root_does_not_satisfy_gate(
    tmp_path: Path,
) -> None:
    repo = build_repo(tmp_path, subdir="nested")
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    spec = repo / "specs" / "tla" / "Demo.tla"
    spec.write_text(spec.read_text(encoding="utf-8") + "\n\\* comment-only touch\n", encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_substantive_spec_update_under_a_subdirectory_root_satisfies_gate(
    tmp_path: Path,
) -> None:
    repo = build_repo(tmp_path, subdir="nested")
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    spec = repo / "specs" / "tla" / "Demo.tla"
    spec.write_text(spec.read_text(encoding="utf-8") + "\nVARIABLE reviewed\n", encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is True
    assert report.drifted == ()


def test_base_text_returns_none_only_when_the_path_is_absent_at_base(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    assert model_impact._base_text(repo, "HEAD", "src/new.rs", {}) is None
    assert "mapped_fn" in (model_impact._base_text(repo, "HEAD", "src/demo.rs", {}) or "")


def test_base_text_propagates_a_git_read_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = build_repo(tmp_path)
    real_git = model_impact._git

    def failing_show(root: Path, *args: str) -> str:
        if args and args[0] == "show":
            raise model_impact.GitError("simulated git failure")
        return real_git(root, *args)

    monkeypatch.setattr(model_impact, "_git", failing_show)
    with pytest.raises(model_impact.GitError):
        model_impact._base_text(repo, "HEAD", "src/demo.rs", {})


def test_form_feed_in_string_does_not_misalign_substance() -> None:
    text = 'fn mapped_fn() {\n    let marker = "a\fb";\n    step_one();\n    step_two(); }\n'
    changed = text.replace("step_two", "step_THREE")
    assert model_impact._fn_substance(text, "mapped_fn") != model_impact._fn_substance(
        changed, "mapped_fn"
    )


def test_substance_signature_ignores_whitespace_and_comments_but_not_literals() -> None:
    base = 'X == "a"  \\* note\n'
    same = 'X  ==  "a"\n'
    changed = 'X == "b"\n'
    assert model_impact._normalized_substance(base, "tla") == model_impact._normalized_substance(
        same, "tla"
    )
    assert model_impact._normalized_substance(base, "tla") != model_impact._normalized_substance(
        changed, "tla"
    )
    rust = 'let x = "a"; // note\n'
    rust_same = 'let  x="a";\n'
    rust_changed = 'let x = "b";\n'
    assert model_impact._normalized_substance(rust, "rust") == model_impact._normalized_substance(
        rust_same, "rust"
    )
    assert model_impact._normalized_substance(rust, "rust") != model_impact._normalized_substance(
        rust_changed, "rust"
    )
    assert model_impact._normalized_substance(
        "let x = 1.0.to_string();", "rust"
    ) == model_impact._normalized_substance("let x = 1.0 .to_string();", "rust")
    assert model_impact._normalized_substance(
        'f("a") + g();', "rust"
    ) != model_impact._normalized_substance('f() + g("a");', "rust")
    doubled = 'X == "a""b"  \\* note\n'
    assert model_impact._normalized_substance(doubled, "tla") == model_impact._normalized_substance(
        'X == "a""b"\n', "tla"
    )
    assert model_impact._normalized_substance(
        'X == "a""b"', "tla"
    ) != model_impact._normalized_substance('X == "a" "b"', "tla")


def test_comment_only_test_update_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    text = demo.read_text(encoding="utf-8").replace("    1\n", "    2\n")
    demo.write_text(
        text.replace(
            "        assert_eq!(super::mapped_fn(), 1);",
            "        // comment-only touch\n        assert_eq!(super::mapped_fn(), 1);",
        ),
        encoding="utf-8",
    )

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_comment_only_z3_proof_update_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    z3 = repo / "tests" / "verification" / "z3.rs"
    z3.write_text("fn z3_proof_demo() {\n}\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "multi-line proof")
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    z3.write_text("fn z3_proof_demo() {\n    // comment-only touch\n}\n", encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_new_shadow_kani_function_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    (repo / "src" / "aaa.rs").write_text("fn proof_demo() {}\n", encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_attributed_shadow_kani_function_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    (repo / "src" / "aaa.rs").write_text(
        "#[kani::proof]\nfn proof_demo() {}\n", encoding="utf-8"
    )

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_same_file_helper_before_test_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(
        demo.read_text(encoding="utf-8").replace(
            "#[cfg(test)]\nmod tests {\n",
            "#[cfg(test)]\nmod tests {\n    fn demo_test() {}\n",
        ),
        encoding="utf-8",
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "add test helper")
    text = demo.read_text(encoding="utf-8").replace("    1\n", "    2\n", 1)
    demo.write_text(
        text.replace("    fn demo_test() {}", "    fn demo_test() { let _ = 1; }", 1),
        encoding="utf-8",
    )

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_comment_only_kani_proof_update_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    text = demo.read_text(encoding="utf-8").replace("    1\n", "    2\n")
    demo.write_text(
        text.replace(
            "    assert!(true);",
            "    // comment-only touch\n    assert!(true);",
        ),
        encoding="utf-8",
    )

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_same_file_helper_before_kani_proof_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    text = demo.read_text(encoding="utf-8").replace(
        "pub fn mapped_fn() -> u32 {\n    1\n}",
        "fn proof_demo() {}\n\npub fn mapped_fn() -> u32 {\n    1\n}",
    )
    text = text.replace("    1\n", "    2\n", 1)
    demo.write_text(
        text.replace("fn proof_demo() {}", "fn proof_demo() { let _ = 1; }", 1),
        encoding="utf-8",
    )

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_same_file_kani_proof_body_still_counts_with_a_helper(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(
        demo.read_text(encoding="utf-8").replace(
            "pub fn mapped_fn() -> u32 {\n    1\n}",
            "fn proof_demo() {}\n\npub fn mapped_fn() -> u32 {\n    1\n}",
        ),
        encoding="utf-8",
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "add helper before the proof")
    text = demo.read_text(encoding="utf-8").replace("    1\n", "    2\n", 1)
    demo.write_text(text.replace("assert!(true);", "assert!(1 == 1);"), encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is True
    assert report.drifted == ()


def test_same_line_sibling_after_kani_proof_does_not_count(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(
        demo.read_text(encoding="utf-8").replace(
            "#[kani::proof]\nfn proof_demo() {\n    assert!(true);\n}\n",
            "#[kani::proof] fn proof_demo() {} fn helper() { let _ = 0; }\n",
        ),
        encoding="utf-8",
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "one-line proof and helper")
    text = demo.read_text(encoding="utf-8").replace("    1\n", "    2\n", 1)
    demo.write_text(text.replace("let _ = 0;", "let _ = 1;"), encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_substantive_kani_proof_update_satisfies_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    text = demo.read_text(encoding="utf-8").replace("    1\n", "    2\n")
    demo.write_text(text.replace("assert!(true);", "assert!(1 == 1);"), encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is True
    assert report.drifted == ()


def test_nested_only_z3_proof_fails_check(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    z3 = repo / "tests" / "verification" / "z3.rs"
    z3.write_text("mod helper {\n    fn z3_proof_demo() {}\n}\n", encoding="utf-8")
    report = run_check(repo)
    assert any("has no top-level definition" in error for error in report.errors)


def test_nested_same_named_z3_function_does_not_satisfy_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    z3 = repo / "tests" / "verification" / "z3.rs"
    z3.write_text(
        "mod helper {\n    fn z3_proof_demo() { let _ = 0; }\n}\n\n"
        "fn z3_proof_demo() {}\n",
        encoding="utf-8",
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "nested z3 duplicate")
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    z3.write_text(
        z3.read_text(encoding="utf-8").replace("let _ = 0;", "let _ = 1;"),
        encoding="utf-8",
    )

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is False
    assert [impact.component.component_id for impact in report.drifted] == ["demo"]


def test_substantive_z3_proof_update_satisfies_gate(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    demo = repo / "src" / "demo.rs"
    demo.write_text(demo.read_text(encoding="utf-8").replace("    1\n", "    2\n"), encoding="utf-8")
    z3 = repo / "tests" / "verification" / "z3.rs"
    z3.write_text("fn z3_proof_demo() {\n    assert!(1 == 1);\n}\n", encoding="utf-8")

    report = run_affected(repo)
    assert report.impacts[0].verification_updated is True
    assert report.drifted == ()


# --- render: stable and checked --------------------------------------------


def test_render_is_stable_and_check_matches(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    manifest = model_impact.load_manifest(repo / model_impact.MANIFEST_REL)
    assert model_impact.write_render(manifest, repo) is False
    assert run_check(repo).errors == []

    docs = repo / model_impact.DIVERGENCES_REL
    docs.write_text(
        docs.read_text(encoding="utf-8").replace("| modeled |", "| stale |"),
        encoding="utf-8",
    )
    assert any("stale" in error for error in run_check(repo).errors)


def test_render_block_is_deterministic(tmp_path: Path) -> None:
    repo = build_repo(tmp_path)
    manifest = model_impact.load_manifest(repo / model_impact.MANIFEST_REL)
    first = model_impact.render_block(manifest)
    second = model_impact.render_block(manifest)
    assert first == second
    assert model_impact.BEGIN_MARKER in first
    assert model_impact.END_MARKER in first
    assert "| `demo` | modeled |" in first


# --- CLI smoke -------------------------------------------------------------


def test_cli_check_returns_zero(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    repo = build_repo(tmp_path)
    assert model_impact.main(["check", "--root", str(repo)]) == 0
    assert "model-impact check: OK" in capsys.readouterr().out
