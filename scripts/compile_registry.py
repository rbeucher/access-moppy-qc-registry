#!/usr/bin/env python3
"""
compile_registry.py
===================

Reads all YAML source files in checks/ and requirements/ and produces a
single registry.json that the dashboard and CI consume.

Usage
-----
    python scripts/compile_registry.py [--output PATH]

The output file defaults to ``dashboard/registry.json``.

Output format
-------------
{
  "generated_at": "<ISO-8601 UTC timestamp>",
  "wcrp": [ <wcrp status objects> ],
  "checks": [ <check objects> ],
  "requirements": [ <requirement objects with wildcards left as-is> ],
  "variables": [ <sorted list of all explicit variable names> ],
  "experiments": [ <sorted list of all explicit experiment names> ],
  "realms": { "<variable>": "<realm>" }
}
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).parent.parent
INVENTORY_FILE = ROOT / "inventory" / "catalog.yaml"


def _load_yaml_file(path: Path) -> list[dict]:
    """Load a YAML file and always return a list of dicts."""
    with path.open() as fh:
        data = yaml.safe_load(fh)
    if data is None:
        return []
    if isinstance(data, list):
        return data
    raise ValueError(f"{path}: expected a YAML list, got {type(data).__name__}")


def _load_yaml_dir(directory: Path) -> list[dict]:
    """Load all *.yaml files in a directory (non-recursive) and return combined list."""
    items: list[dict] = []
    for yaml_file in sorted(directory.glob("*.yaml")):
        items.extend(_load_yaml_file(yaml_file))
    return items


def load_inventory() -> dict[str, object]:
    """Load optional synced variable/experiment inventory."""
    if not INVENTORY_FILE.exists():
        return {"variables": [], "experiments": [], "aliases": {}}
    with INVENTORY_FILE.open() as fh:
        data = yaml.safe_load(fh) or {}
    variables: list[str] = []
    aliases: dict[str, str] = {}
    for entry in data.get("variables", []) or []:
        if isinstance(entry, str):
            variables.append(entry)
            continue
        name = entry.get("name")
        if not name:
            continue
        variables.append(name)
        if entry.get("short_name"):
            aliases[name] = entry["short_name"]
    return {
        "variables": sorted(set(variables)),
        "experiments": sorted(set(data.get("experiments", []) or [])),
        "aliases": aliases,
    }


def load_checks() -> list[dict]:
    checks_dir = ROOT / "checks"
    checks: list[dict] = []
    for yaml_file in sorted(checks_dir.glob("*.yaml")):
        for check in _load_yaml_file(yaml_file):
            # Inject source file for traceability
            check["_source"] = yaml_file.name
            checks.append(check)
    return checks


def load_wcrp_statuses() -> list[dict]:
    wcrp_file = ROOT / "requirements" / "wcrp.yaml"
    if not wcrp_file.exists():
        return []
    statuses = _load_yaml_file(wcrp_file)
    for entry in statuses:
        entry["_source"] = "wcrp.yaml"
    return statuses


def load_requirements() -> list[dict]:
    req_root = ROOT / "requirements"
    requirements: list[dict] = []

    # Global requirements
    global_file = req_root / "global.yaml"
    if global_file.exists():
        for req in _load_yaml_file(global_file):
            req["_source"] = "global.yaml"
            requirements.append(req)

    # Per-variable requirements
    variables_dir = req_root / "variables"
    if variables_dir.exists():
        for yaml_file in sorted(variables_dir.glob("*.yaml")):
            for req in _load_yaml_file(yaml_file):
                req["_source"] = f"variables/{yaml_file.name}"
                requirements.append(req)

    # Per-experiment overrides
    experiments_dir = req_root / "experiments"
    if experiments_dir.exists():
        for yaml_file in sorted(experiments_dir.glob("*.yaml")):
            for req in _load_yaml_file(yaml_file):
                req["_source"] = f"experiments/{yaml_file.name}"
                requirements.append(req)

    return requirements


def collect_variables(requirements: list[dict]) -> list[str]:
    """Return sorted list of all explicit variable names (excludes '*')."""
    variables: set[str] = set()
    for req in requirements:
        var = req.get("variable", "*")
        if isinstance(var, list):
            for v in var:
                if v != "*":
                    variables.add(v)
        elif var != "*":
            variables.add(str(var))
    return sorted(variables)


def collect_experiments(requirements: list[dict]) -> list[str]:
    """Return sorted list of all explicit experiment names (excludes '*')."""
    experiments: set[str] = set()
    for req in requirements:
        exp = req.get("experiment", "*")
        if isinstance(exp, list):
            for e in exp:
                if e != "*":
                    experiments.add(e)
        elif exp != "*":
            experiments.add(str(exp))
    return sorted(experiments)


def build_realm_map(variables_dir: Path) -> dict[str, str]:
    """
    Build a variable -> realm mapping by scanning requirements/variables/*.yaml
    filenames.  The convention is that the YAML file name is the variable name.
    Realm is inferred from a comment header or left as "unknown".
    """
    realm_map: dict[str, str] = {}
    if not variables_dir.exists():
        return realm_map

    for yaml_file in variables_dir.glob("*.yaml"):
        var_name = yaml_file.stem
        # Try to extract realm from the first line comment: "# Realm: <realm>"
        with yaml_file.open() as fh:
            for line in fh:
                if line.startswith("# Realm:"):
                    realm = line.split(":", 1)[1].strip().split()[0].lower()
                    realm_map[var_name] = realm
                    break
            else:
                realm_map[var_name] = "unknown"

    return realm_map


def compile_registry(output: Path) -> None:
    wcrp = load_wcrp_statuses()
    checks = load_checks()
    requirements = load_requirements()
    inventory = load_inventory()
    variables = inventory["variables"] or collect_variables(requirements)
    experiments = inventory["experiments"] or collect_experiments(requirements)
    realm_map = build_realm_map(ROOT / "requirements" / "variables")
    aliases = inventory["aliases"]
    for variable, alias in aliases.items():
        if alias in realm_map and variable not in realm_map:
            realm_map[variable] = realm_map[alias]

    registry = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "wcrp": wcrp,
        "checks": checks,
        "requirements": requirements,
        "variables": variables,
        "experiments": experiments,
        "realms": realm_map,
        "variable_aliases": aliases,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w") as fh:
        json.dump(registry, fh, indent=2)

    print(
        f"Registry compiled: {len(wcrp)} WCRP statuses, {len(checks)} checks, "
        f"{len(requirements)} requirements, "
        f"{len(variables)} variables, {len(experiments)} experiments → {output}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile QC registry YAML to JSON")
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "dashboard" / "registry.json",
        help="Path to write registry.json (default: dashboard/registry.json)",
    )
    args = parser.parse_args()
    try:
        compile_registry(args.output)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
