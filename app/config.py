"""Reads sensors.yaml (plus this Pi's sensors.local.yaml, if there is one) and .env.

sensors.local.yaml holds changes for THIS Pi only. It isn't in Git, so editing it never
blocks `git pull`. It only lists what differs from sensors.yaml, by sensor id:

    sensors:
      plug:
        enabled: false     # no smart plug on this test
      lepton:
        scale: [0, 35]

Each listed setting replaces the one in sensors.yaml; everything else comes from sensors.yaml,
so new sensors or settings added to sensors.yaml still arrive with a pull.
"""
import os
from pathlib import Path

import logging

import yaml

ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("config")


def load_env(path: Path = ROOT / ".env"):
    """Minimal .env reader (KEY=value per line), so secrets stay out of the code and out of Git."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def local_path(path) -> Path:
    """sensors.yaml -> sensors.local.yaml (demo.yaml -> demo.local.yaml)."""
    p = Path(path)
    return p.with_name(f"{p.stem}.local{p.suffix}")


def apply_local(cfg: dict, path) -> dict:
    """Overlay this Pi's <name>.local.yaml on the config, if the file exists."""
    lp = local_path(path)
    if not lp.exists():
        return cfg
    with open(lp) as f:
        local = yaml.safe_load(f) or {}
    if not isinstance(local, dict):
        raise ValueError(f"{lp.name} must be 'key: value' settings")
    by_id = {s.get("id"): s for s in cfg.get("sensors", [])}
    changed = []
    for sid, settings in (local.get("sensors") or {}).items():
        if sid not in by_id:
            log.warning("%s: no sensor '%s' in %s, ignored", lp.name, sid, Path(path).name)
            continue
        if not isinstance(settings, dict) or {"id", "type"} & set(settings):
            raise ValueError(f"{lp.name}: '{sid}' must list settings to change (not id or type)")
        by_id[sid].update(settings)
        changed.append(f"{sid} ({', '.join(settings)})")
    for key, value in local.items():
        if key != "sensors":
            cfg[key] = value
            changed.append(key)
    log.info("%s applied: %s", lp.name, "; ".join(changed) or "nothing")
    return cfg


def load_config(path) -> dict:
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
    cfg = apply_local(cfg, path)
    cfg.setdefault("site", "rig1")
    cfg.setdefault("sensors", [])
    ids = [s.get("id") for s in cfg["sensors"]]
    for s in cfg["sensors"]:
        if "id" not in s or "type" not in s:
            raise ValueError(f"every sensor needs an 'id' and a 'type': {s}")
    if len(ids) != len(set(ids)):
        raise ValueError("sensor ids in sensors.yaml must be unique")
    return cfg
