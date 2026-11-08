"""Asset profiles: what the readings MEAN for the object under test (kettle, toaster, ...).

sensors.yaml says what hardware is plugged in ("TC-08 channel 1 is a K-type probe").
An asset profile says what that hardware means for this object:

    {
      "id": "kettle", "name": "Kettle",
      "power": "plug.power",            # point id for electrical power (W)
      "state": "plug.on",               # point id for on/off
      "thermal": "lepton.image",        # which camera to show
      "ambient": ["ambient.air_temp", "ambient.humidity"],
      "probes": [                       # thermocouples placed on this object
        {"point": "tc08.ch1", "label": "Water", "x": 55, "y": 60},   # x, y = dot position on the drawing, in %
        ...
      ],
      "drawing": "kettle",              # picture the dots sit on: kettle | matrix | generic | photo (uploaded)
      "water_level": 60,                # kettle drawing: how full, in % of the inside height
      "panel": "power",                 # top-left panel: power (smart plug) | compare (camera vs camera)
      "camera_scale": {"lepton": [0, 35]},   # per camera: fixed colour range in degC, or "auto"
      "spots": [                        # camera spots: fixed points on a thermal image, read like a probe
        {"id": 1, "camera": "lepton", "label": "Fan 1", "x": 30, "y": 50}   # x, y in % of the image
      ]
    }

Switching to a new object = a new profile (made from the dashboard), no code changes.
Profiles live in data/assets/ as JSON, so the dashboard can edit them. data/ is not in
Git, so edits on the Pi never clash with `git pull`. On first start the examples in
assets_default/ are copied in.
"""
from __future__ import annotations

import json
import re
import shutil
import threading
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
DRAWINGS = ("kettle", "matrix", "generic", "photo")  # built-in 2D drawings, or the uploaded photo
PANELS = ("power", "compare")
MAX_SPOTS = 8
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s or "asset")[:40]


class AssetError(ValueError):
    """Bad input from the dashboard; shown to the user as-is."""


class Assets:
    def __init__(self, data_dir: Path, defaults_dir: Path):
        self.dir = Path(data_dir) / "assets"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._state_path = Path(data_dir) / "state.json"
        self._lock = threading.Lock()
        # Built-in profiles (assets_default/) that aren't here yet are copied in, so a new one
        # (e.g. test-rig) appears after a git pull. Existing profiles are never overwritten.
        if Path(defaults_dir).is_dir():
            for f in Path(defaults_dir).glob("*.json"):
                if not (self.dir / f.name).exists():
                    shutil.copy(f, self.dir / f.name)
        # Profiles saved before drawings existed: give the kettle the kettle drawing.
        for p in self.dir.glob("*.json"):
            a = json.loads(p.read_text())
            if "drawing" not in a:
                a["drawing"] = "kettle" if a.get("id") == "kettle" else ("photo" if a.get("image") else "generic")
                p.write_text(json.dumps(a, indent=2))

    # ---- reading ----
    def list(self) -> list[dict]:
        return [self._load(p.stem) for p in sorted(self.dir.glob("*.json"))]

    def get(self, asset_id: str) -> dict:
        if not ID_RE.match(asset_id or "") or not (self.dir / f"{asset_id}.json").exists():
            raise AssetError(f"no asset '{asset_id}'")
        return self._load(asset_id)

    def active_id(self) -> str | None:
        try:
            aid = json.loads(self._state_path.read_text()).get("active_asset")
        except (OSError, ValueError):
            aid = None
        ids = [p.stem for p in sorted(self.dir.glob("*.json"))]
        return aid if aid in ids else (ids[0] if ids else None)

    def active(self) -> dict | None:
        aid = self.active_id()
        return self.get(aid) if aid else None

    def labels(self, asset: dict | None) -> dict[str, str]:
        """point_id -> label from the asset's probes and camera spots (used to relabel cards and recordings)."""
        out = {p["point"]: p["label"] for p in (asset or {}).get("probes", [])}
        out.update({spot_point(s): s["label"] for s in (asset or {}).get("spots", [])})
        return out

    # ---- writing (from the dashboard) ----
    def set_active(self, asset_id: str) -> None:
        self.get(asset_id)  # validates
        with self._lock:
            self._state_path.write_text(json.dumps({"active_asset": asset_id}))

    def save(self, asset: dict) -> dict:
        clean = self._validate(asset)
        with self._lock:
            path = self.dir / f"{clean['id']}.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(clean, indent=2))
            tmp.replace(path)  # atomic: a power cut can't leave a half-written file
        return clean

    def create(self, name: str, copy_from: str | None = None) -> dict:
        base = self.get(copy_from) if copy_from else {"probes": []}
        aid, n = slugify(name), 2
        while (self.dir / f"{aid}.json").exists():
            aid, n = f"{slugify(name)}-{n}", n + 1
        asset = {**base, "id": aid, "name": name.strip() or aid, "image": None}
        return self.save(asset)

    def save_image(self, asset_id: str, data: bytes, content_type: str) -> dict:
        asset = self.get(asset_id)
        if content_type not in IMAGE_TYPES:
            raise AssetError("picture must be PNG, JPEG or WebP")
        if len(data) > MAX_IMAGE_BYTES:
            raise AssetError("picture is larger than 8 MB")
        for old in self.dir.glob(f"{asset_id}.img.*"):
            old.unlink()
        name = f"{asset_id}.img{IMAGE_TYPES[content_type]}"
        (self.dir / name).write_bytes(data)
        asset["image"] = name
        asset["drawing"] = "photo"
        return self.save(asset)

    def image_path(self, asset_id: str) -> Path | None:
        name = self.get(asset_id).get("image")
        return self.dir / name if name and (self.dir / name).exists() else None

    # ---- helpers ----
    def _load(self, asset_id: str) -> dict:
        return json.loads((self.dir / f"{asset_id}.json").read_text())

    @staticmethod
    def _validate(a: dict) -> dict:
        if not isinstance(a, dict):
            raise AssetError("asset must be an object")
        aid = str(a.get("id", ""))
        if not ID_RE.match(aid):
            raise AssetError("id must be lower-case letters, numbers, - or _")
        point = lambda v: (str(v) if v else None)  # noqa: E731
        probes = []
        seen = set()
        for p in a.get("probes") or []:
            pid = str(p.get("point", "")).strip()
            if not pid or pid in seen:
                continue
            seen.add(pid)
            x, y = float(p.get("x", 50)), float(p.get("y", 50))
            probes.append({
                "point": pid,
                "label": (str(p.get("label") or pid).strip())[:40],
                "x": min(max(x, 0.0), 100.0),
                "y": min(max(y, 0.0), 100.0),
            })
        return {
            "id": aid,
            "name": str(a.get("name") or aid)[:60],
            "power": point(a.get("power")),
            "state": point(a.get("state")),
            "thermal": point(a.get("thermal")),
            "ambient": [str(x) for x in (a.get("ambient") or [])][:4],
            "image": a.get("image") if isinstance(a.get("image"), str) else None,
            "notes": str(a.get("notes") or "")[:500],
            "drawing": a.get("drawing") if a.get("drawing") in DRAWINGS else "generic",
            "water_level": min(max(float(a.get("water_level", 60) or 0), 0.0), 100.0),
            "panel": a.get("panel") if a.get("panel") in PANELS else "power",
            "camera_scale": _clean_scales(a.get("camera_scale")),
            "probes": probes,
            "spots": _clean_spots(a.get("spots")),
        }


def spot_point(spot: dict) -> str:
    """Point id of a camera spot, e.g. lepton.spot1. It belongs to the camera, so it shares its status."""
    return f"{spot['camera']}.spot{spot['id']}"


def _clean_scales(v) -> dict:
    """{"lepton": [lo, hi] | "auto"} -> checked copy (unknown or bad entries dropped)."""
    out = {}
    for cam, sc in (v or {}).items() if isinstance(v, dict) else []:
        if not ID_RE.match(str(cam)):
            continue
        if sc == "auto":
            out[str(cam)] = "auto"
        elif isinstance(sc, (list, tuple)) and len(sc) == 2:
            try:
                lo, hi = float(sc[0]), float(sc[1])
            except (TypeError, ValueError):
                raise AssetError("camera range must be two numbers")
            if not (-40 <= lo < hi <= 600):
                raise AssetError("camera range: min must be below max (both between -40 and 600 °C)")
            out[str(cam)] = [round(lo, 1), round(hi, 1)]
    return out


def _clean_spots(v) -> list[dict]:
    spots, used = [], set()
    for s in (v or [])[:MAX_SPOTS] if isinstance(v, list) else []:
        cam = str(s.get("camera", ""))
        if not ID_RE.match(cam):
            continue
        try:
            sid = int(s.get("id"))
        except (TypeError, ValueError):
            sid = 0
        if not 1 <= sid <= MAX_SPOTS or (cam, sid) in used:  # give it the lowest free number
            sid = next(n for n in range(1, MAX_SPOTS + 1) if (cam, n) not in used)
        used.add((cam, sid))
        x, y = float(s.get("x", 50)), float(s.get("y", 50))
        spots.append({
            "id": sid, "camera": cam,
            "label": (str(s.get("label") or f"Spot {sid}").strip())[:40],
            "x": round(min(max(x, 0.0), 100.0), 2),
            "y": round(min(max(y, 0.0), 100.0), 2),
        })
    return spots
