#!/usr/bin/env python3
"""Create a safe static-site export for GitHub Pages.

Only website-facing HTML/JS/CSS, the generated public manifest/shards, and an allowlisted policy-status snapshot are copied.
The private staging master, publication gate, backend source, tests, reports and task files
are excluded. Build with tools/build_release.py first.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "public-site"
PRIVATE_FILE_NAMES = {
    "answer", "answerkey", "correctanswer", "correctoption", "solution", "solutionhtml",
    "explanation", "accepted", "acceptedrange", "natanswer", "rawsource", "scoring",
    "marksawarded", "key",
}
SITE_FILE_EXTENSIONS = {".html", ".js", ".css"}
SOURCE_PRIVATE = {
    "questions-staging-v1.json", "PUBLICATION_GATE.json", ".build-release-output.json",
}


class ExportError(RuntimeError):
    pass


def jbytes(obj: Any) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def private_paths(node: Any, where: str = "$") -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if normalized_key(str(key)) in {normalized_key(k) for k in PRIVATE_FILE_NAMES}:
                found.append(f"{where}.{key}")
            found.extend(private_paths(value, f"{where}.{key}"))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            found.extend(private_paths(value, f"{where}[{i}]"))
    return found


def remove_owned_export(out: Path) -> None:
    marker = out / ".public-site-export.json"
    if out.exists() and any(out.iterdir()):
        if not marker.is_file():
            raise ExportError(f"Output directory is non-empty and was not created by this exporter: {out}")
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ExportError("Existing export marker is unreadable; refusing to delete export.") from exc
        if data.get("generated_by") != "tools/export_public_site.py":
            raise ExportError("Existing output marker does not belong to this exporter.")
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)


def ensure_public_data() -> tuple[dict[str, Any], int]:
    data_dir = ROOT / "data"
    manifest_path = data_dir / "manifest.json"
    if not manifest_path.is_file():
        raise ExportError("data/manifest.json is missing. Run: python tools/build_release.py --mode public")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ExportError(f"data/manifest.json is invalid JSON: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1 or not isinstance(manifest.get("shards"), list) or not manifest["shards"]:
        raise ExportError("Public manifest is invalid or has no shards.")
    if manifest.get("placeholder") is not True:
        gate_path = data_dir / "PUBLICATION_GATE.json"
        gate = json.loads(gate_path.read_text(encoding="utf-8")) if gate_path.is_file() else {}
        if not (gate.get("redistribution_confirmed") is True and isinstance(gate.get("approval_reference"), str) and gate["approval_reference"].strip()):
            raise ExportError("Refusing non-placeholder export: rights gate does not contain a confirmed approval reference.")
    total = 0
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    for entry in manifest["shards"]:
        if not isinstance(entry, dict):
            raise ExportError("Manifest has an invalid shard entry.")
        relative = entry.get("path")
        if not isinstance(relative, str) or not re.fullmatch(r"papers/[A-Z]{2}/\d{4}(?:/[A-Za-z0-9][A-Za-z0-9_-]{0,31})?\.json", relative):
            raise ExportError(f"Unsafe public shard path: {relative!r}")
        if relative in seen_paths:
            raise ExportError(f"Duplicate manifest path: {relative}")
        seen_paths.add(relative)
        shard_path = data_dir / relative
        if not shard_path.is_file():
            raise ExportError(f"Manifest shard is missing: {relative}")
        raw = shard_path.read_bytes()
        if sha(raw) != entry.get("sha256"):
            raise ExportError(f"Shard digest mismatch: {relative}")
        shard = json.loads(raw.decode("utf-8"))
        if not isinstance(shard, dict) or shard.get("schema_version") != 1 or not isinstance(shard.get("questions"), list):
            raise ExportError(f"Invalid shard schema: {relative}")
        if len(shard["questions"]) != entry.get("question_count"):
            raise ExportError(f"Shard count mismatch: {relative}")
        leaks = private_paths(shard)
        if leaks:
            raise ExportError(f"Private field(s) in public shard {relative}: {leaks[:5]}")
        for question in shard["questions"]:
            qid = question.get("id") if isinstance(question, dict) else None
            if not isinstance(qid, str) or qid in seen_ids:
                raise ExportError(f"Missing or duplicate public question ID in {relative}: {qid!r}")
            seen_ids.add(qid)
        total += len(shard["questions"])
    return manifest, total


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out = args.output_dir.resolve()
    root = ROOT.resolve()
    if out == root or out in {root / "data", root / "output", root / "private-release", root / "reports", root / "tests", root / "tools"}:
        raise ExportError("Unsafe output location.")
    if root in out.parents and out.parent != root:
        raise ExportError("An in-project export must be a dedicated direct child of the project root.")
    manifest, count = ensure_public_data()
    remove_owned_export(out)

    # Copy only web-facing top-level pages/assets.
    copied = []
    for path in sorted(ROOT.iterdir(), key=lambda p: p.name):
        if path.is_file() and path.suffix.lower() in SITE_FILE_EXTENSIONS:
            shutil.copy2(path, out / path.name)
            copied.append(path.name)

    data_out = out / "data"
    data_out.mkdir(parents=True, exist_ok=True)
    # Copy only files needed by the site. Never copy the private staging master or gate.
    for name in ("manifest.json", "questions.json", "EXAM_POLICY_STATUS.json"):
        source = ROOT / "data" / name
        if source.is_file():
            shutil.copy2(source, data_out / name)
    (data_out / "papers").mkdir(parents=True, exist_ok=True)
    for entry in manifest["shards"]:
        relative = entry["path"]
        source = ROOT / "data" / relative
        target = data_out / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    # Keep a tiny marker so subsequent runs can safely replace only this generated export.
    (out / ".public-site-export.json").write_bytes(jbytes({
        "generated_by": "tools/export_public_site.py",
        "manifest_sha256": sha((ROOT / "data" / "manifest.json").read_bytes()),
        "placeholder": manifest.get("placeholder") is True,
        "public_question_count": count,
        "copied_top_level_web_files": copied,
    }))
    # Post-copy security check: no staging or gate file can exist in the export.
    forbidden = ["questions-staging-v1.json", "PUBLICATION_GATE.json", "website-all-questions-staging.json"]
    for name in forbidden:
        if (out / "data" / name).exists() or (out / "output" / name).exists():
            raise ExportError(f"Private file unexpectedly present in public export: {name}")
    print(json.dumps({
        "export_dir": str(out),
        "top_level_web_files": len(copied),
        "placeholder": manifest.get("placeholder") is True,
        "public_question_count": count,
        "staging_master_copied": False,
        "private_backend_copied": False,
        "private_reports_copied": False,
        "exam_policy_status_copied": (data_out / "EXAM_POLICY_STATUS.json").is_file(),
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ExportError as exc:
        print(f"PUBLIC EXPORT REFUSED: {exc}", file=sys.stderr)
        raise SystemExit(2)
