#!/usr/bin/env python3
"""Model-impact manifest and proof-drift gate for Fortress Rollback.

``check`` validates ``docs/specs/verification-manifest.toml``: every mapped
path, symbol, TLA spec/check, Kani harness, Z3 proof, and Rust test exists,
residual review dates are current, and the generated alignment table in
``docs/specs/spec-divergences.md`` is fresh.

``affected --base <rev>`` maps a git diff to manifest components. A mapped
symbol (or a mapped path with no symbol mapping) that changed without a mapped
spec/proof/test update in the same diff or an unexpired waiver exits 1.

``render`` regenerates the table between the generated-block markers.

Missing files, specs, checks, harnesses, and tests fail closed. Symbol regex
checks are advisory: this pass deliberately avoids a Rust parser (see #579).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, NamedTuple, cast

try:
    import tomllib  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - Python < 3.11
    import tomli as tomllib

ROOT = Path(__file__).resolve().parent.parent.parent
MANIFEST_REL = Path("docs/specs/verification-manifest.toml")
DIVERGENCES_REL = Path("docs/specs/spec-divergences.md")
VERIFY_TLA_REL = Path("scripts/verification/verify-tla.sh")
VERIFY_KANI_REL = Path("scripts/verification/verify-kani.sh")
Z3_REL = Path("tests/verification/z3.rs")
BEGIN = "<!-- BEGIN GENERATED: verification-alignment -->"
END = "<!-- END GENERATED: verification-alignment -->"
# Backwards/CLI-friendly aliases used by tests and docs.
BEGIN_MARKER = BEGIN
END_MARKER = END
STATUSES = {"modeled", "bounded", "unmodeled", "stale"}
TLA_ARRAYS = ("SPECS", "EXPECTED_FAILURE_CHECKS", "ADDITIONAL_CHECKS", "TRACE_CHECKS")
DEFINITION_RE = r"\b(?:fn|struct|enum|trait|type|const|static|mod|union)\s+{name}\b"
FN_RE = re.compile(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)")


class ManifestError(Exception):
    """A manifest file is missing, unparsable, or structurally invalid."""


class GitError(Exception):
    """A git command needed for the impact query failed."""


class Residual(NamedTuple):
    residual_id: str
    description: str
    review_by: dt.date


class Component(NamedTuple):
    component_id: str
    status: str
    owner: str
    last_reviewed: dt.date
    paths: tuple[str, ...]
    symbols: tuple[str, ...]
    specs: tuple[str, ...]
    kani: tuple[str, ...]
    z3: tuple[str, ...]
    tests: tuple[str, ...]
    scope: str
    residuals: tuple[Residual, ...]


class Waiver(NamedTuple):
    component: str
    reason: str
    approver: str
    expires: dt.date


class Manifest(NamedTuple):
    schema_version: int
    components: tuple[Component, ...]
    waivers: tuple[Waiver, ...]


class Report(NamedTuple):
    errors: list[str]
    warnings: list[str]

    @property
    def ok(self) -> bool:
        return not self.errors


class FileDiff(NamedTuple):
    path: str
    new_lines: frozenset[int]
    added_text: tuple[str, ...]
    removed_text: tuple[str, ...]
    deleted: bool


class ComponentImpact(NamedTuple):
    component: Component
    reasons: tuple[str, ...]
    commands: tuple[str, ...]
    verification_updated: bool
    waiver: Waiver | None

    @property
    def drifted(self) -> bool:
        return bool(self.reasons) and not self.verification_updated and self.waiver is None


class ImpactReport(NamedTuple):
    base: str
    impacts: tuple[ComponentImpact, ...]

    @property
    def drifted(self) -> tuple[ComponentImpact, ...]:
        return tuple(impact for impact in self.impacts if impact.drifted)


def _table(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{where} must be a table")
    return cast(dict[str, Any], value)


def _str(table: dict[str, Any], key: str, where: str) -> str:
    value = table.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{where}.{key} must be a non-empty string")
    return value.strip()


def _strs(table: dict[str, Any], key: str, where: str) -> tuple[str, ...]:
    value = table.get(key, [])
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise ManifestError(f"{where}.{key} must be a list of non-empty strings")
    return tuple(item.strip() for item in value)


def _date(table: dict[str, Any], key: str, where: str) -> dt.date:
    raw = _str(table, key, where)
    try:
        return dt.date.fromisoformat(raw)
    except ValueError as error:
        raise ManifestError(f"{where}.{key} is not an ISO date: {raw}") from error


def _relpath(raw: str, where: str) -> str:
    path = raw.replace("\\", "/")
    if path.startswith(("/", "../")) or "/../" in path or path == "..":
        raise ManifestError(f"{where} must be repository-relative: {raw}")
    return path


def _symbol(raw: str, where: str) -> str:
    path, separator, name = raw.partition("::")
    if not separator or not path or not name.strip():
        raise ManifestError(f"{where} entries must be 'path::symbol': {raw}")
    return f"{_relpath(path, where)}::{name.strip()}"


def _residual(table: dict[str, Any], where: str) -> Residual:
    return Residual(
        residual_id=_str(table, "id", where),
        description=_str(table, "description", where),
        review_by=_date(table, "review_by", where),
    )


def _component(table: dict[str, Any], where: str) -> Component:
    residuals = table.get("residuals", [])
    if not isinstance(residuals, list):
        raise ManifestError(f"{where}.residuals must be a list of tables")
    return Component(
        component_id=_str(table, "id", where),
        status=_str(table, "status", where),
        owner=_str(table, "owner", where),
        last_reviewed=_date(table, "last_reviewed", where),
        paths=tuple(_relpath(path, where) for path in _strs(table, "paths", where)),
        symbols=tuple(_symbol(symbol, where) for symbol in _strs(table, "symbols", where)),
        specs=tuple(_relpath(spec, where) for spec in _strs(table, "specs", where)),
        kani=_strs(table, "kani", where),
        z3=_strs(table, "z3", where),
        tests=_strs(table, "tests", where),
        scope=_str(table, "scope", where),
        residuals=tuple(
            _residual(_table(item, f"{where}.residuals[{index}]"), f"{where}.residuals[{index}]")
            for index, item in enumerate(residuals)
        ),
    )


def _waiver(table: dict[str, Any], where: str) -> Waiver:
    return Waiver(
        component=_str(table, "component", where),
        reason=_str(table, "reason", where),
        approver=_str(table, "approver", where),
        expires=_date(table, "expires", where),
    )


def parse_manifest_text(text: str, source: str = "<manifest>") -> Manifest:
    """Parse and structurally validate manifest TOML."""
    try:
        raw: Any = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ManifestError(f"{source}: invalid TOML: {error}") from error
    data = _table(raw, source)
    version = data.get("schema_version")
    if not isinstance(version, int) or version != 1:
        raise ManifestError(f"{source}: schema_version must be 1")
    components = data.get("component", [])
    if not isinstance(components, list) or not components:
        raise ManifestError(f"{source}: at least one [[component]] is required")
    waivers = data.get("waiver", [])
    if not isinstance(waivers, list):
        raise ManifestError(f"{source}: [[waiver]] entries must be a list")
    return Manifest(
        1,
        tuple(
            _component(_table(item, f"{source}: component[{index}]"), f"{source}: component[{index}]")
            for index, item in enumerate(components)
        ),
        tuple(
            _waiver(_table(item, f"{source}: waiver[{index}]"), f"{source}: waiver[{index}]")
            for index, item in enumerate(waivers)
        ),
    )


def load_manifest(path: Path) -> Manifest:
    """Read and parse the manifest at *path*."""
    try:
        return parse_manifest_text(path.read_text(encoding="utf-8"), str(path))
    except OSError as error:
        raise ManifestError(f"{path}: cannot read manifest: {error}") from error


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _rust_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for base_name in ("src", "tests"):
        base = root / base_name
        if base.is_dir():
            files.extend(sorted(base.rglob("*.rs")))
    return files


def function_index(root: Path) -> dict[str, Path]:
    """Map every Rust ``fn`` name under src/tests to its first defining file."""
    index: dict[str, Path] = {}
    for path in _rust_files(root):
        for match in FN_RE.finditer(_read(path) or ""):
            index.setdefault(match.group(1), path)
    return index


def registrations(root: Path) -> tuple[set[str], set[str], set[str]]:
    """Return registered TLA checks, Kani harnesses, and Z3 test names."""
    tla_text = _read(root / VERIFY_TLA_REL) or ""
    tla: set[str] = set()
    for array in TLA_ARRAYS:
        match = re.search(rf"^{array}=\((.*?)^\)", tla_text, re.DOTALL | re.MULTILINE)
        if match is not None:
            tla.update(re.findall(r'"([A-Za-z0-9_]+)"', match.group(1)))
    kani_text = _read(root / VERIFY_KANI_REL) or ""
    kani: set[str] = set()
    for tier in (1, 2, 3):
        match = re.search(rf"^TIER{tier}_PROOFS=\((.*?)^\)", kani_text, re.DOTALL | re.MULTILINE)
        if match is not None:
            kani.update(re.findall(r'"((?:proof|verify)_\w+)"', match.group(1)))
    z3 = set(re.findall(r"(?m)^\s*fn\s+(z3_\w+)\s*\(", _read(root / Z3_REL) or ""))
    return tla, kani, z3


def _symbol_state(root: Path, symbol: str, cache: dict[Path, str | None]) -> tuple[bool, str]:
    path_text, _, name = symbol.partition("::")
    path = root / path_text
    if not path.is_file():
        return False, f"symbol path does not exist: {path_text}"
    if path not in cache:
        cache[path] = _read(path)
    if re.search(DEFINITION_RE.format(name=re.escape(name)), cache[path] or ""):
        return True, ""
    return True, f"symbol '{name}' has no definition in {path_text} (advisory)"


def _covers(check: str, stem: str) -> bool:
    """Return True when a registered check name covers a spec stem.

    Trace specs are generated and registered as ``<stem>Contract``; every
    other spec must match its registered check exactly. A prefix match would
    let a variant companion satisfy an unregistered base spec.
    """
    return check in {stem, f"{stem}Contract"}


def tla_checks(component: Component) -> tuple[str, ...]:
    """Return the registered TLA check names for a component's specs."""
    return tuple(Path(spec).stem for spec in component.specs)


def check_manifest(manifest: Manifest, root: Path, today: dt.date | None = None) -> Report:
    """Validate *manifest* against the tree rooted at *root*."""
    today = today or dt.date.today()
    errors: list[str] = []
    warnings: list[str] = []
    tla, kani, z3 = registrations(root)
    fn_index: dict[str, Path] | None = None
    symbol_cache: dict[Path, str | None] = {}
    if not tla:
        errors.append(f"cannot read registered TLA checks from {VERIFY_TLA_REL}")
    if not kani:
        errors.append(f"cannot read registered Kani harnesses from {VERIFY_KANI_REL}")

    seen: set[str] = set()
    for component in manifest.components:
        cid = component.component_id
        if cid in seen:
            errors.append(f"{cid}: duplicate component id")
        seen.add(cid)
        if component.status not in STATUSES:
            errors.append(f"{cid}: status '{component.status}' is not one of {sorted(STATUSES)}")
        if component.status in {"modeled", "bounded"} and not (
            component.specs or component.kani or component.z3 or component.tests
        ):
            errors.append(f"{cid}: status '{component.status}' requires a mapped verification artifact")
        if component.last_reviewed > today:
            errors.append(f"{cid}: last_reviewed {component.last_reviewed} is in the future")
        if not component.paths:
            errors.append(f"{cid}: at least one production path is required")
        for path_text in component.paths:
            if not (root / path_text).is_file():
                errors.append(f"{cid}: mapped path does not exist: {path_text}")
        for symbol in component.symbols:
            ok, message = _symbol_state(root, symbol, symbol_cache)
            if not ok:
                errors.append(f"{cid}: {message}")
            elif message:
                warnings.append(f"{cid}: {message}")
        for spec in component.specs:
            if not (root / spec).is_file():
                errors.append(f"{cid}: TLA spec does not exist: {spec}")
        for check in tla_checks(component):
            if check not in tla and not any(_covers(registered, check) for registered in tla):
                errors.append(f"{cid}: TLA check '{check}' is not registered in {VERIFY_TLA_REL}")
        for proof in component.kani:
            if proof not in kani:
                errors.append(f"{cid}: Kani harness '{proof}' is not registered in {VERIFY_KANI_REL}")
        for proof in component.z3:
            if proof not in z3:
                errors.append(f"{cid}: Z3 proof '{proof}' is not defined in {Z3_REL}")
        if fn_index is None:
            fn_index = function_index(root)
        for test in component.tests:
            if test.rsplit("::", 1)[-1] not in fn_index:
                errors.append(f"{cid}: Rust test '{test}' has no definition under src/ or tests/")
        residual_ids: set[str] = set()
        for residual in component.residuals:
            if residual.residual_id in residual_ids:
                errors.append(f"{cid}: duplicate residual id '{residual.residual_id}'")
            residual_ids.add(residual.residual_id)
            if residual.review_by < today:
                errors.append(f"{cid}: residual '{residual.residual_id}' review_by {residual.review_by} has expired")
    for waiver in manifest.waivers:
        if waiver.component not in seen:
            errors.append(f"waiver: unknown component '{waiver.component}'")
        if waiver.expires < today:
            errors.append(f"waiver for '{waiver.component}' expired on {waiver.expires}")
        if waiver.approver.lower() in {"todo", "tbd", "implementer"}:
            errors.append(f"waiver for '{waiver.component}' needs a named approver")
    errors.extend(_render_errors(manifest, root))
    return Report(errors, warnings)


def _extract(text: str) -> str:
    start = text.index(BEGIN)
    return text[start : text.index(END, start) + len(END)]


def _render_errors(manifest: Manifest, root: Path) -> list[str]:
    text = _read(root / DIVERGENCES_REL)
    if text is None:
        return []
    if BEGIN not in text or END not in text or text.index(END) < text.index(BEGIN):
        return [f"{DIVERGENCES_REL}: generated alignment markers are missing or out of order"]
    if _extract(text) != render_block(manifest):
        return [f"{DIVERGENCES_REL}: generated alignment table is stale; run render"]
    return []


def _cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ").strip()


def _model_cell(component: Component) -> str:
    parts: list[str] = []
    if component.specs:
        parts.append(", ".join(f"`{Path(spec).name}`" for spec in component.specs))
    if component.kani:
        parts.append(f"{len(component.kani)} Kani")
    if component.z3:
        parts.append(f"{len(component.z3)} Z3")
    if component.tests:
        suffix = "s" if len(component.tests) != 1 else ""
        parts.append(f"{len(component.tests)} Rust test{suffix}")
    return "; ".join(parts) if parts else "none"


def render_block(manifest: Manifest) -> str:
    """Render the generated alignment table."""
    lines = [
        BEGIN,
        "<!-- Generated by scripts/verification/model-impact.py render from "
        "docs/specs/verification-manifest.toml. Do not edit by hand. -->",
        "",
        "| Component | Status | Model / proof artifacts | Production paths | Residual risks |",
        "| --------- | ------ | ----------------------- | ---------------- | -------------- |",
    ]
    for component in manifest.components:
        residuals = (
            "; ".join(f"{item.residual_id} ({item.review_by})" for item in component.residuals)
            or "none"
        )
        lines.append(
            f"| `{_cell(component.component_id)}` | {_cell(component.status)} | "
            f"{_cell(_model_cell(component))} | "
            f"{_cell(', '.join(f'`{path}`' for path in component.paths))} | "
            f"{_cell(residuals)} |"
        )
    lines.append(END)
    return "\n".join(lines)


def write_render(manifest: Manifest, root: Path) -> bool:
    """Rewrite the generated block. Return True when the file changed."""
    path = root / DIVERGENCES_REL
    text = _read(path)
    if text is None:
        raise ManifestError(f"{path}: cannot read {DIVERGENCES_REL}")
    if BEGIN not in text or END not in text:
        raise ManifestError(f"{path}: generated alignment markers are missing")
    updated = text.replace(_extract(text), render_block(manifest))
    if updated == text:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def parse_git_diff(text: str) -> dict[str, FileDiff]:
    """Parse ``git diff -U0`` output into per-file changed lines."""
    raw: dict[str, list[Any]] = {}
    current: list[Any] | None = None
    old_path = ""
    new_line = 0
    in_hunk = False
    for line in text.splitlines():
        if line.startswith("diff --git "):
            current, in_hunk, old_path = None, False, ""
            continue
        if current is not None and line.startswith("@@"):
            match = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            new_line = int(match.group(1)) if match else 0
            in_hunk = True
            continue
        if current is not None and in_hunk:
            if line.startswith("+"):
                current[0].add(new_line)
                current[1].append(line[1:])
                new_line += 1
            elif line.startswith("-"):
                current[2].append(line[1:])
            elif line.startswith(" "):
                new_line += 1
            continue
        if line.startswith("--- "):
            old = line[4:].strip()
            old_path = old[2:] if old.startswith("a/") else old
        elif line.startswith("+++ "):
            new = line[4:].strip()
            deleted = new == "/dev/null"
            path = old_path if deleted else (new[2:] if new.startswith("b/") else new)
            current = raw.setdefault(path, [set(), [], [], False])
            current[3] = deleted
            in_hunk = False
    return {
        path: FileDiff(path, frozenset(lines), tuple(added), tuple(removed), bool(deleted))
        for path, (lines, added, removed, deleted) in raw.items()
    }


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise GitError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def _fn_range(path: Path, name: str) -> tuple[int, int] | None:
    lines = (_read(path) or "").splitlines()
    for start, line in enumerate(lines):
        if not re.search(rf"\bfn\s+{re.escape(name)}\b", line):
            continue
        depth = 0
        seen = False
        for end in range(start, len(lines)):
            depth += lines[end].count("{") - lines[end].count("}")
            seen = seen or "{" in lines[end]
            if seen and depth <= 0:
                return start + 1, end + 1
        return start + 1, len(lines)
    return None


def _range_hit(diff: FileDiff | None, span: tuple[int, int] | None) -> bool:
    return bool(diff and span and any(span[0] <= line <= span[1] for line in diff.new_lines))


def _symbol_hits(
    root: Path, component: Component, changed: set[str], diffs: dict[str, FileDiff]
) -> list[str]:
    reasons: list[str] = []
    symbol_paths = {symbol.partition("::")[0] for symbol in component.symbols}
    for path_text in sorted(changed & (set(component.paths) | symbol_paths)):
        names = [
            symbol.partition("::")[2]
            for symbol in component.symbols
            if symbol.partition("::")[0] == path_text
        ]
        diff = diffs.get(path_text)
        if not names:
            reasons.append(f"{path_text} (mapped path)")
            continue
        if diff is not None and diff.deleted:
            reasons.append(f"{path_text} (deleted)")
            continue
        hit = [
            name
            for name in names
            if _range_hit(diff, _fn_range(root / path_text, name))
            or (diff is not None and any(name in line for line in diff.added_text + diff.removed_text))
        ]
        if hit:
            reasons.append(f"{path_text} ({', '.join(hit)})")
        elif not any(_fn_range(root / path_text, name) for name in names):
            reasons.append(f"{path_text} (mapped path; symbol ranges not found)")
    return reasons


def _verification_updated(
    root: Path,
    component: Component,
    changed: set[str],
    diffs: dict[str, FileDiff],
    fn_index: dict[str, Path],
) -> bool:
    if any(spec in changed for spec in component.specs):
        return True
    z3_rel = Z3_REL.as_posix()
    if any(_range_hit(diffs.get(z3_rel), _fn_range(root / Z3_REL, proof)) for proof in component.z3):
        return True
    for name in (*component.kani, *(test.rsplit("::", 1)[-1] for test in component.tests)):
        location = fn_index.get(name)
        if location is not None and _range_hit(
            diffs.get(location.relative_to(root).as_posix()), _fn_range(location, name)
        ):
            return True
    return False


def _commands(component: Component) -> tuple[str, ...]:
    commands = [f"./scripts/verification/verify-tla.sh {check}" for check in tla_checks(component)]
    commands.extend(f"cargo kani --harness {proof}" for proof in component.kani)
    if component.z3:
        commands.append("cargo test --features z3-verification --test verification z3")
    commands.extend(f"cargo nextest run {test.rsplit('::', 1)[-1]}" for test in component.tests)
    return tuple(commands)


def affected_components(
    manifest: Manifest, root: Path, base: str = "origin/main", today: dt.date | None = None
) -> ImpactReport:
    """Map the diff from *base* to components and detect missing updates."""
    today = today or dt.date.today()
    changed = {line.strip() for line in _git(root, "diff", "--name-only", "--no-color", base).splitlines() if line.strip()}
    diffs = parse_git_diff(_git(root, "diff", "-U0", "--no-color", base))
    fn_index = function_index(root)
    impacts: list[ComponentImpact] = []
    for component in manifest.components:
        reasons = _symbol_hits(root, component, changed, diffs)
        if not reasons:
            continue
        waiver = next(
            (
                item
                for item in manifest.waivers
                if item.component == component.component_id and item.expires >= today
            ),
            None,
        )
        impacts.append(
            ComponentImpact(
                component,
                tuple(reasons),
                _commands(component),
                _verification_updated(root, component, changed, diffs, fn_index),
                waiver,
            )
        )
    return ImpactReport(base, tuple(impacts))


def format_impact(report: ImpactReport) -> str:
    """Format an impact report for humans."""
    if not report.impacts:
        return f"No mapped verification impact (base {report.base})."
    lines = [f"Verification impact (base {report.base}):"]
    for impact in report.impacts:
        lines.append(f"  {impact.component.component_id} [{impact.component.status}]")
        lines.extend(f"    changed: {reason}" for reason in impact.reasons)
        if impact.verification_updated:
            lines.append("    verification update: present")
        elif impact.waiver is not None:
            lines.append(
                f"    verification update: waived by {impact.waiver.approver} "
                f"until {impact.waiver.expires} ({impact.waiver.reason})"
            )
        else:
            lines.append("    verification update: MISSING (update a model/proof or add a waiver)")
        if impact.commands:
            lines.append("    commands:")
            lines.extend(f"      {command}" for command in impact.commands)
        else:
            lines.append("    commands: none mapped")
    if report.drifted:
        lines.append(
            f"ERROR: {len(report.drifted)} component(s) changed without a model/proof "
            "update or active waiver."
        )
    return "\n".join(lines)


def _manifest_path(root: Path, argument: str | None) -> Path:
    return Path(argument) if argument else root / MANIFEST_REL


def _cmd_check(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    try:
        manifest = load_manifest(_manifest_path(root, args.manifest))
        report = check_manifest(manifest, root)
    except ManifestError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"ok": report.ok, "errors": report.errors, "warnings": report.warnings}))
        return 0 if report.ok else 1
    for warning in report.warnings:
        print(f"WARNING: {warning}")
    for message in report.errors:
        print(f"ERROR: {message}", file=sys.stderr)
    if report.ok:
        artifacts = sum(
            len(component.specs)
            + len(component.kani)
            + len(component.z3)
            + len(component.tests)
            for component in manifest.components
        )
        print(
            f"model-impact check: OK ({len(manifest.components)} components, "
            f"{sum(len(component.symbols) for component in manifest.components)} symbols, "
            f"{artifacts} artifacts)"
        )
    return 0 if report.ok else 1


def _cmd_affected(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    try:
        report = affected_components(
            load_manifest(_manifest_path(root, args.manifest)), root, base=args.base
        )
    except (ManifestError, GitError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(
            json.dumps(
                {
                    "base": report.base,
                    "components": [
                        {
                            "id": impact.component.component_id,
                            "status": impact.component.status,
                            "reasons": list(impact.reasons),
                            "commands": list(impact.commands),
                            "verification_updated": impact.verification_updated,
                            "waived": impact.waiver is not None,
                            "drifted": impact.drifted,
                        }
                        for impact in report.impacts
                    ],
                    "drifted": [impact.component.component_id for impact in report.drifted],
                }
            )
        )
    else:
        print(format_impact(report))
    return 1 if report.drifted and not args.advisory else 0


def _cmd_render(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    try:
        manifest = load_manifest(_manifest_path(root, args.manifest))
        if args.check:
            errors = _render_errors(manifest, root)
            for message in errors:
                print(f"ERROR: {message}", file=sys.stderr)
            if not errors:
                print("model-impact render: up to date")
            return 1 if errors else 0
        changed = write_render(manifest, root)
    except ManifestError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"model-impact render: {'updated' if changed else 'already up to date'}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate and query the code-to-verification manifest.")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.add_argument("--root", default=str(ROOT))
    check.add_argument("--manifest")
    check.add_argument("--json", action="store_true")
    check.set_defaults(func=_cmd_check)
    affected = sub.add_parser("affected")
    affected.add_argument("--root", default=str(ROOT))
    affected.add_argument("--manifest")
    affected.add_argument("--base", default="origin/main")
    affected.add_argument("--advisory", action="store_true")
    affected.add_argument("--json", action="store_true")
    affected.set_defaults(func=_cmd_affected)
    render = sub.add_parser("render")
    render.add_argument("--root", default=str(ROOT))
    render.add_argument("--manifest")
    render.add_argument("--check", action="store_true")
    render.set_defaults(func=_cmd_render)
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    args = build_parser().parse_args(argv)
    return cast(int, args.func(args))


if __name__ == "__main__":
    sys.exit(main())
