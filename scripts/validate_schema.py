#!/usr/bin/env python3
"""
validate_schema.py
==================

Validates YAML source files against their JSON Schemas and optionally
cross-references check ids used in requirements against the checks catalogue.

Usage
-----
    # Validate a directory of YAML files against a schema
    python scripts/validate_schema.py checks/ schemas/check.schema.json

    # Validate a single YAML file
    python scripts/validate_schema.py requirements/global.yaml schemas/requirement.schema.json

    # Cross-reference only (no schema arg needed)
    python scripts/validate_schema.py --cross-reference
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

try:
    import jsonschema
except ImportError:
    print("ERROR: jsonschema is required — pip install jsonschema", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).parent.parent


def _load_yaml(path: Path) -> list[dict]:
    with path.open() as fh:
        data = yaml.safe_load(fh)
    if data is None:
        return []
    if isinstance(data, list):
        return data
    raise ValueError(f"{path}: expected a YAML list, got {type(data).__name__}")


def _load_schema(schema_path: Path) -> dict:
    with schema_path.open() as fh:
        return json.load(fh)


def validate_files(target: Path, schema_path: Path) -> int:
    """
    Validate all YAML entries in *target* (file or directory) against *schema*.
    Returns the number of errors found.
    """
    schema = _load_schema(schema_path)
    validator = jsonschema.Draft7Validator(schema)

    yaml_files: list[Path] = []
    if target.is_dir():
        yaml_files = sorted(target.glob("*.yaml"))
    elif target.is_file():
        yaml_files = [target]
    else:
        print(f"ERROR: {target} does not exist", file=sys.stderr)
        return 1

    errors_total = 0
    for yaml_file in yaml_files:
        try:
            items = _load_yaml(yaml_file)
        except Exception as exc:
            print(f"  PARSE ERROR {yaml_file}: {exc}")
            errors_total += 1
            continue

        for i, item in enumerate(items):
            errs = sorted(validator.iter_errors(item), key=lambda e: e.path)
            for err in errs:
                path_str = ".".join(str(p) for p in err.absolute_path) or "(root)"
                print(f"  {yaml_file.name}[{i}] .{path_str}: {err.message}")
                errors_total += 1

        if not items:
            print(f"  WARNING: {yaml_file.name} is empty")

    return errors_total


def cross_reference() -> int:
    """
    Verify every check id referenced in requirements/ exists in checks/.
    Returns the number of broken references.
    """
    # Build catalogue of known check ids
    checks_dir = ROOT / "checks"
    known_ids: set[str] = set()
    for yaml_file in checks_dir.glob("*.yaml"):
        for check in _load_yaml(yaml_file):
            cid = check.get("id")
            if cid:
                known_ids.add(cid)

    # Scan all requirement files
    req_root = ROOT / "requirements"
    broken = 0
    req_files: list[Path] = []
    for pattern in ["global.yaml", "variables/*.yaml", "experiments/*.yaml"]:
        req_files.extend(sorted(req_root.glob(pattern)))

    for req_file in req_files:
        for i, req in enumerate(_load_yaml(req_file)):
            check_id = req.get("check")
            if check_id and check_id not in known_ids:
                print(
                    f"  BROKEN REF {req_file.relative_to(ROOT)}[{i}]: "
                    f"check '{check_id}' not found in catalogue"
                )
                broken += 1

    return broken


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate QC registry YAML files")
    parser.add_argument(
        "target",
        nargs="?",
        type=Path,
        help="YAML file or directory to validate",
    )
    parser.add_argument(
        "schema",
        nargs="?",
        type=Path,
        help="JSON Schema file to validate against",
    )
    parser.add_argument(
        "--cross-reference",
        action="store_true",
        help="Check that all check ids in requirements/ exist in checks/",
    )
    args = parser.parse_args()

    errors = 0

    if args.cross_reference:
        print("Cross-referencing requirements against check catalogue …")
        errors += cross_reference()

    if args.target and args.schema:
        print(f"Validating {args.target} against {args.schema} …")
        errors += validate_files(args.target, args.schema)

    if errors:
        print(f"\n{errors} error(s) found — see above.")
        sys.exit(1)
    else:
        print("All checks passed.")


if __name__ == "__main__":
    main()
