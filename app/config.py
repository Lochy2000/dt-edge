"""Reads sensors.yaml and .env."""
import os
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def load_env(path: Path = ROOT / ".env"):
    """Minimal .env reader (KEY=value per line), so secrets stay out of the code and out of Git."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_config(path) -> dict:
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
    cfg.setdefault("site", "rig1")
    cfg.setdefault("sensors", [])
    ids = [s.get("id") for s in cfg["sensors"]]
    for s in cfg["sensors"]:
        if "id" not in s or "type" not in s:
            raise ValueError(f"every sensor needs an 'id' and a 'type': {s}")
    if len(ids) != len(set(ids)):
        raise ValueError("sensor ids in sensors.yaml must be unique")
    return cfg
