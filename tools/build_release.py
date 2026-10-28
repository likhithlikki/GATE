#!/usr/bin/env python3
"""Deterministic GATE Prep Studio release builder.

Public output is a synthetic placeholder unless BOTH conditions hold:
  1) data/PUBLICATION_GATE.json has redistribution_confirmed=true plus an approval_reference; and
  2) the caller passes --publish-real.

Private mode builds verified source-derived records under private-release/data/ and
is intended for owner-only use. Never commit private-release/, the staging master,
or reports/private/ to a public repository.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data" / "questions-staging-v1.json"
GATE_PATH = ROOT / "data" / "PUBLICATION_GATE.json"
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
BRANCH_RE = re.compile(r"^[A-Z]{2}$")
VARIANT_RE = re.compile(r"^[A-Za-z0-9_-]{1,16}$")
PRIVATE_KEYS = {
    "answer", "answerkey", "correctanswer", "correctoption", "solution", "solutionhtml",
    "explanation", "accepted", "acceptedrange", "natanswer", "rawsource", "scoring",
    "marksawarded", "key", "answer_key", "correct_answer", "accepted_range",
}
ALLOWED_RECORD_KEYS = {"id", "branch", "year", "subject", "topic", "type", "marks", "text", "options", "source"}
ALLOWED_OPTION_KEYS = {"id", "text"}


class BuildError(RuntimeError):
    pass


def json_bytes(obj: Any) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2, separators=(",", ": ")) + "\n").encode("utf-8")


def write_json(path: Path, obj: Any) -> bytes:
    data = json_bytes(obj)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def norm_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def scan_private_keys(node: Any, where: str = "$") -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            normalized = norm_key(str(key))
            if normalized in {norm_key(k) for k in PRIVATE_KEYS}:
                found.append(f"{where}.{key}")
            found.extend(scan_private_keys(value, f"{where}.{key}"))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            found.extend(scan_private_keys(value, f"{where}[{i}]"))
    return found


def load_source(path: Path) -> tuple[dict[str, Any], bytes]:
    if not path.is_file():
        raise BuildError(f"Staging master not found: {path}")
    raw_bytes = path.read_bytes()
    try:
        doc = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"Staging master is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(doc, dict) or doc.get("schema_version") != 1 or not isinstance(doc.get("questions"), list):
        raise BuildError("Staging master schema must have schema_version=1 and a questions list.")
    ids = []
    for i, q in enumerate(doc["questions"]):
        if not isinstance(q, dict):
            raise BuildError(f"Source row {i} is not a JSON object; refusing to build.")
        qid = q.get("id")
        if not isinstance(qid, str) or not ID_RE.fullmatch(qid):
            raise BuildError(f"Source row {i} has an invalid ID; refusing to build.")
        ids.append(qid)
    duplicates = sorted(qid for qid, count in collections.Counter(ids).items() if count > 1)
    if duplicates:
        raise BuildError(f"Duplicate source IDs found ({len(duplicates)}); refusing to build. First IDs: {duplicates[:10]}")
    return doc, raw_bytes


def valid_public_record(rec: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if set(rec) != ALLOWED_RECORD_KEYS:
        problems.append("record_fields_not_allowlisted")
    if not isinstance(rec.get("id"), str) or not ID_RE.fullmatch(rec["id"]):
        problems.append("invalid_id")
    for name in ("branch", "subject", "topic"):
        val = rec.get(name)
        if not isinstance(val, str) or not val.strip() or len(val) > 100:
            problems.append(f"invalid_{name}")
    year = rec.get("year")
    if isinstance(year, bool) or not isinstance(year, int) or not (1900 <= year <= 2100):
        problems.append("invalid_year")
    if rec.get("type") not in {"MCQ", "MSQ", "NAT"}:
        problems.append("invalid_type")
    marks = rec.get("marks")
    if isinstance(marks, bool) or not isinstance(marks, int) or marks <= 0:
        problems.append("invalid_marks")
    text = rec.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 20000:
        problems.append("invalid_text")
    if rec.get("type") in {"MCQ", "MSQ"}:
        options = rec.get("options")
        if not isinstance(options, list) or len(options) < 2:
            problems.append("invalid_options_count")
        else:
            seen: set[str] = set()
            for option in options:
                if not isinstance(option, dict) or set(option) != ALLOWED_OPTION_KEYS:
                    problems.append("invalid_option_fields")
                    continue
                oid, otxt = option.get("id"), option.get("text")
                if not isinstance(oid, str) or not oid.strip() or len(oid) > 16:
                    problems.append("invalid_option_id")
                elif oid in seen:
                    problems.append("duplicate_option_id")
                seen.add(oid)
                if not isinstance(otxt, str) or not otxt.strip() or len(otxt) > 5000:
                    problems.append("invalid_option_text")
    elif rec.get("options") != []:
        problems.append("NAT_options_must_be_empty")
    source = rec.get("source")
    if not isinstance(source, dict) or set(source) != {"name"} or not isinstance(source.get("name"), str) or not source["name"].strip() or len(source["name"]) > 200:
        problems.append("invalid_source_provenance")
    if scan_private_keys(rec):
        problems.append("private_field_leakage")
    return sorted(set(problems))


def has_question_media_dependency(q: dict[str, Any]) -> bool:
    """No unresolved question/option image path is allowed into a release."""
    for item in q.get("media_refs", []) if isinstance(q.get("media_refs"), list) else []:
        field = str(item.get("field", "")).lower()
        if field == "raw_source.text" or field.startswith("raw_source.options"):
            return True
    return False


def normalized_record(q: dict[str, Any]) -> dict[str, Any]:
    qtype = q.get("type")
    options = []
    if qtype in {"MCQ", "MSQ"}:
        source_opts = q.get("options")
        if not isinstance(source_opts, list):
            source_opts = []
        for option in source_opts:
            if not isinstance(option, dict):
                continue
            label = option.get("label")
            options.append({"id": label, "text": option.get("text")})
    return {
        "id": q.get("id"),
        "branch": q.get("branch"),
        "year": q.get("year"),
        "subject": q.get("subject"),
        "topic": q.get("topic"),
        "type": qtype,
        "marks": q.get("marks"),
        "text": q.get("text").strip() if isinstance(q.get("text"), str) else q.get("text"),
        "options": options,
        "source": {"name": (q.get("source") or {}).get("name")} if isinstance(q.get("source"), dict) else {},
    }


def identify_exclusion(q: dict[str, Any]) -> str | None:
    mapping = q.get("mapping") if isinstance(q.get("mapping"), dict) else {}
    status = mapping.get("status")
    if status != "paper_year_confident":
        return f"mapping_status:{status or 'missing'}"
    if not isinstance(q.get("branch"), str) or not BRANCH_RE.fullmatch(q["branch"]):
        return "unverified_or_invalid_paper_code"
    year = q.get("year")
    if isinstance(year, bool) or not isinstance(year, int) or not (1900 <= year <= 2100):
        return "unverified_or_invalid_year"
    if mapping.get("conflict"):
        return "identity_conflict"
    text = q.get("text")
    if not isinstance(text, str) or not text.strip():
        return "missing_question_text"
    if q.get("requires_image_review") or q.get("release_status") == "REQUIRES_IMAGE_RENDERING":
        return "requires_image_review"
    if has_question_media_dependency(q):
        return "unresolved_question_or_option_image"
    variant = q.get("variant")
    if variant is not None and (not isinstance(variant, str) or not VARIANT_RE.fullmatch(variant)):
        return "invalid_set_variant"
    return None


def collect_verified(source_doc: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    included: list[dict[str, Any]] = []
    excluded: dict[str, list[str]] = collections.defaultdict(list)
    invalid: list[dict[str, Any]] = []
    eligible_mapping_rows = 0
    for q in source_doc["questions"]:
        exclusion = identify_exclusion(q)
        if exclusion:
            excluded[exclusion].append(q["id"])
            continue
        eligible_mapping_rows += 1
        rec = normalized_record(q)
        problems = valid_public_record(rec)
        if problems:
            invalid.append({"id": q["id"], "reasons": problems})
            excluded["invalid_after_allowlist_validation"].append(q["id"])
            continue
        included.append(rec)
    # Strictly reject duplicates in the release even though the source-wide scan already rejects them.
    release_ids = [q["id"] for q in included]
    if len(release_ids) != len(set(release_ids)):
        raise BuildError("Duplicate IDs survived the release filter; refusing to write any release files.")
    # Manifest validator forbids a set-less file and set-based files for the same paper/year.
    year_variants: dict[tuple[str, int], set[str | None]] = collections.defaultdict(set)
    for q in included:
        year_variants[(q["branch"], q["year"])].add(q.get("variant"))
    mixed = [(key, variants) for key, variants in year_variants.items() if None in variants and len(variants) > 1]
    if mixed:
        raise BuildError(f"Conflicting set metadata mixes set-less and set-based records in {len(mixed)} paper/year groups; refusing release.")
    report = {
        "source_record_count": len(source_doc["questions"]),
        "source_declared_question_count": source_doc.get("question_count"),
        "source_dataset_kind": source_doc.get("dataset_kind"),
        "verified_identity_rows_before_field_validation": eligible_mapping_rows,
        "public_candidate_count": len(included),
        "excluded_count": sum(len(ids) for ids in excluded.values()),
        "exclusions_by_reason": {k: len(v) for k, v in sorted(excluded.items())},
        "excluded_ids": {k: sorted(v, key=lambda value: (len(value), value)) for k, v in sorted(excluded.items())},
        "invalid_records": sorted(invalid, key=lambda row: (len(row["id"]), row["id"])),
        "note": "This report contains IDs and data-quality decisions only. It is PRIVATE; never publish reports/private/.",
    }
    return included, report


def build_shards(records: list[dict[str, Any]], output_data: Path, release: str, placeholder: bool = False) -> dict[str, Any]:
    papers: dict[str, str] = {}
    groups: dict[tuple[str, int, str | None], list[dict[str, Any]]] = collections.defaultdict(list)
    for rec in records:
        code = rec["branch"]
        name = rec["subject"]
        if code in papers and papers[code] != name:
            raise BuildError(f"Paper {code} has inconsistent subject/name values; refusing to invent a paper name.")
        papers[code] = name
        groups[(code, rec["year"], rec.get("variant"))].append(rec)
    if not groups:
        raise BuildError("Cannot build a manifest with zero shards; keep the placeholder release instead.")
    entries = []
    for (code, year, variant), questions in sorted(groups.items(), key=lambda item: (item[0][0], item[0][1], item[0][2] or "")):
        questions.sort(key=lambda q: (len(q["id"]), q["id"]))
        if len(questions) > 1000:
            raise BuildError(f"Shard {code}/{year}/{variant or ''} exceeds 1000 records.")
        if variant:
            filename = f"{variant}.json"
            relative = f"papers/{code}/{year}/{filename}"
            shard_id = f"{code}-{year}-{variant}"
        else:
            relative = f"papers/{code}/{year}.json"
            shard_id = f"{code}-{year}"
        shard = {"schema_version": 1, "questions": questions}
        leak = scan_private_keys(shard)
        if leak:
            raise BuildError(f"Private field(s) detected in {relative}: {leak[:5]}")
        raw = json_bytes(shard)
        path = output_data / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        entries.append({
            "id": shard_id, "paper_code": code, "paper_name": papers[code], "year": year,
            **({"variant": variant} if variant else {}),
            "path": relative, "question_count": len(questions), "sha256": sha256(raw),
        })
    manifest = {"schema_version": 1, "release": release, "placeholder": placeholder, "shards": entries}
    raw_manifest = json_bytes(manifest)
    (output_data / "manifest.json").write_bytes(raw_manifest)
    return {
        "manifest": manifest,
        "shard_count": len(entries),
        "question_count": sum(entry["question_count"] for entry in entries),
        "manifest_sha256": sha256(raw_manifest),
    }


def synthetic_question() -> dict[str, Any]:
    return {
        "id": "DEMO-001",
        "branch": "ZZ",
        "year": 2099,
        "subject": "SYNTHETIC DEMO ONLY — NOT AN OFFICIAL GATE PAPER",
        "topic": "Placeholder demonstration",
        "type": "MCQ",
        "marks": 1,
        "text": "SYNTHETIC DEMO ONLY: If x = 2, what is x + 3? This is not a real GATE question.",
        "options": [
            {"id": "A", "text": "3"},
            {"id": "B", "text": "4"},
            {"id": "C", "text": "5"},
            {"id": "D", "text": "6"},
        ],
        "source": {"name": "GATE Prep Studio synthetic placeholder; not taken from an exam"},
    }


def write_marker(output_data: Path, mode: str, source_hash: str | None) -> None:
    write_json(output_data / ".build-release-output.json", {
        "generated_by": "tools/build_release.py",
        "mode": mode,
        "source_sha256": source_hash,
        "private": mode == "private",
    })


def prepare_output_dir(output_data: Path, mode: str) -> None:
    # Only clean directories the builder itself previously generated. Do not delete arbitrary user data.
    marker = output_data / ".build-release-output.json"
    if output_data.exists() and any(output_data.iterdir()):
        if not marker.is_file():
            raise BuildError(f"Output directory is non-empty and not builder-owned; refusing to overwrite: {output_data}")
        shutil.rmtree(output_data)
    output_data.mkdir(parents=True, exist_ok=True)


def prepare_public_data_dir(output_data: Path) -> None:
    """Prepare generated public files without ever touching the private staging master."""
    marker = output_data / ".build-release-output.json"
    if marker.is_file():
        try:
            previous = json.loads(marker.read_text(encoding="utf-8"))
        except Exception as exc:
            raise BuildError("Existing public build marker is unreadable; refusing to clean generated data.") from exc
        if previous.get("generated_by") != "tools/build_release.py" or previous.get("mode") not in {"public-placeholder", "public-real"}:
            raise BuildError("Existing public build marker is not recognized; refusing to clean data/.")
        papers = output_data / "papers"
        if papers.exists():
            shutil.rmtree(papers)
        for name in ("manifest.json", "questions.json", ".build-release-output.json"):
            target = output_data / name
            if target.is_file():
                target.unlink()
    else:
        # Do not overwrite a manifest or shard directory we did not create.
        if (output_data / "manifest.json").exists() or (output_data / "papers").exists():
            raise BuildError("data/ already contains a manifest or papers/ directory not owned by this builder.")
    output_data.mkdir(parents=True, exist_ok=True)


def read_gate() -> dict[str, Any]:
    if not GATE_PATH.is_file():
        return {"redistribution_confirmed": False, "approval_reference": None}
    try:
        gate = json.loads(GATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BuildError(f"Publication gate is invalid JSON: {exc}") from exc
    if not isinstance(gate, dict) or not isinstance(gate.get("redistribution_confirmed"), bool):
        raise BuildError("Publication gate must be an object with redistribution_confirmed boolean.")
    return gate


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json_bytes(report))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("public", "private"), default="public",
                        help="public writes to data/ and remains synthetic unless rights are explicitly confirmed; private writes owner-only source-derived shards.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="private staging JSON input")
    parser.add_argument("--output-dir", type=Path, default=None, help="generated data directory; private mode defaults to private-release/data")
    parser.add_argument("--publish-real", action="store_true", help="explicitly allow real public output; requires a gate approval reference")
    parser.add_argument("--release", default="2026-10-28", help="deterministic release identifier (letters, digits, dot, underscore, hyphen)")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", args.release):
        parser.error("--release must use only letters, digits, dot, underscore or hyphen.")

    gate = read_gate()
    gate_approved = gate.get("redistribution_confirmed") is True and isinstance(gate.get("approval_reference"), str) and bool(gate["approval_reference"].strip())
    if args.mode == "public" and args.publish_real and not gate_approved:
        raise BuildError("Real public output refused: publication gate is not confirmed with a non-empty approval_reference.")

    # Synthetic public builds intentionally do not need to open/read the source staging master.
    # Real-public and private modes require the source master.
    if args.mode == "public" and not args.publish_real:
        source_doc, source_hash = None, None
    else:
        source_doc, source_raw = load_source(args.source)
        source_hash = sha256(source_raw)

    if args.mode == "public":
        out_dir = (args.output_dir or (ROOT / "data")).resolve()
        if out_dir != (ROOT / "data").resolve():
            raise BuildError("Public mode may only write to the repository data/ directory.")
        if args.publish_real:
            records, report = collect_verified(source_doc)
            release = build_shards(records, out_dir, args.release, placeholder=False)
            write_marker(out_dir, "public-real", source_hash)
            report.update({"mode": "public-real", "rights_gate": "confirmed_with_approval_reference",
                           "source_sha256": source_hash, "release": release})
            write_report(report, ROOT / "reports" / "private" / "build-release-v1.json")
            print(json.dumps({"mode": "public-real", **{k: release[k] for k in ("shard_count", "question_count", "manifest_sha256")}}, indent=2))
            return 0
        # Default public build is always a visibly marked synthetic fixture, even if the rights gate is later changed.
        prepare_public_data_dir(out_dir)
        q = synthetic_question()
        problems = valid_public_record(q)
        if problems:
            raise BuildError(f"Internal synthetic fixture failed validation: {problems}")
        raw_shard = json_bytes({"schema_version": 1, "questions": [q]})
        shard_rel = "papers/ZZ/2099.json"
        (out_dir / shard_rel).parent.mkdir(parents=True, exist_ok=True)
        (out_dir / shard_rel).write_bytes(raw_shard)
        manifest = {
            "schema_version": 1, "release": args.release, "placeholder": True,
            "shards": [{
                "id": "ZZ-2099-DEMO", "paper_code": "ZZ",
                "paper_name": "SYNTHETIC DEMO ONLY — NOT AN OFFICIAL GATE PAPER",
                "year": 2099, "path": shard_rel,
                "question_count": 1, "sha256": sha256(raw_shard),
            }],
        }
        # Keep the legacy fallback safe too; it contains the same synthetic example only.
        write_json(out_dir / "questions.json", {"schema_version": 1, "placeholder": True, "questions": [q]})
        write_json(out_dir / "manifest.json", manifest)
        write_marker(out_dir, "public-placeholder", source_hash)
        report = {
            "mode": "public-placeholder", "rights_gate": "NOT_CONFIRMED" if not gate_approved else "confirmed_but_public_real_not_requested",
            "public_record_count": 1, "real_staging_records_published": 0,
            "source_sha256": source_hash,
            "note": "Generated public data contains one clearly synthetic demo question only. The source staging master remains in the owner-only project tree; deploy public-site/ only, not the project root.",
        }
        write_report(report, ROOT / "reports" / "private" / "public-build-summary-v1.json")
        print(json.dumps(report, indent=2))
        return 0

    # Private mode is deliberately separate from data/ to keep real source-derived content out of the public website directory.
    out_dir = (args.output_dir or (ROOT / "private-release" / "data")).resolve()
    if out_dir == (ROOT / "data").resolve() or ROOT / "data" in out_dir.parents:
        raise BuildError("Private mode cannot write under data/; choose private-release/ or another owner-only directory.")
    records, report = collect_verified(source_doc)
    prepare_output_dir(out_dir, "private")
    release = build_shards(records, out_dir, args.release, placeholder=False)
    write_marker(out_dir, "private", source_hash)
    report.update({
        "mode": "private", "rights_gate": "NOT_CONFIRMED" if not gate_approved else "confirmed",
        "source_sha256": source_hash,
        "release": {k: v for k, v in release.items() if k != "manifest"},
        "note": "Owner-only source-derived output. Do not publish private-release/ or this report.",
    })
    write_report(report, ROOT / "reports" / "private" / "build-release-v1.json")
    print(json.dumps({
        "mode": "private",
        "source_record_count": report["source_record_count"],
        "verified_public_candidate_count": report["public_candidate_count"],
        "excluded_count": report["excluded_count"],
        "shard_count": release["shard_count"],
        "question_count": release["question_count"],
        "manifest_sha256": release["manifest_sha256"],
        "rights_gate": report["rights_gate"],
        "private_output": str(out_dir),
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as exc:
        print(f"BUILD FAILED CLOSED: {exc}", file=sys.stderr)
        raise SystemExit(2)
