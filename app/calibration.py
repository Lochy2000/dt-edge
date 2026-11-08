"""Thermal camera calibration (step 1): how far off is the camera, and how does that change with distance?

The method
  A thermocouple (TC) is taped under a matte black patch (e.g. 50 x 50 mm electrical tape) on
  the asset. The tape gives the camera a surface it reads well (emissivity ~0.95), so what's
  left is mostly the distance effect: as the camera moves back, the patch covers fewer pixels
  and each pixel blends the patch with whatever is around it. For each distance we:
    1. click the patch on the live image -> a small box of pixels
    2. capture ~10 s: average the TC, the box (mean and max), and a ring of pixels around the
       patch (the "background" the patch gets blended with)
    3. save one point
  Nothing here changes live readings. This only measures; correcting comes later.

Two ways each point records the error
  error_*  = camera - TC, in degC                    (simple, but only true for this asset/temperature)
  loss_*   = (TC - camera) / (TC - background)       (the share of the patch-to-background
                                                      difference the camera lost; 0 = perfect,
                                                      1 = reads the same as the background).
                                                      Carries over to other assets/temperatures.

Expected patch size in pixels (patch_px) comes from the camera's horizontal field of view
(hfov_deg in sensors.yaml; Lepton 3.5 = 57 deg):
    one pixel covers  2 * distance * tan(hfov / 2) / image_width   metres
    patch_px        = patch width / one pixel

Storage: one session = one calibration exercise (one camera, one reference TC, one patch size).
    data/calibration/<session id>/session.json   setup + every captured point
    data/calibration/<session id>/p001.npy       the averaged camera image for each point (degC),
                                                 so the box can be re-picked later without redoing it
"""
from __future__ import annotations

import csv
import io
import json
import logging
import math
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.assets import slugify

log = logging.getLogger("calibration")

SESSION_ID_RE = re.compile(r"^\d{8}-\d{6}(_[a-z0-9-]+)?$")
DEFAULT_HFOV = {"lepton": 57.0}  # used if sensors.yaml has no hfov_deg for the camera
RING_PX = 3                      # width of the background ring, in pixels
MIN_CONTRAST_C = 3.0             # below this TC-background difference, loss_* isn't meaningful
MAX_BOX_PX = 21
WARN_SLOPE_C_PER_MIN = 1.0       # TC changing faster than this during a capture -> warning
WARN_MIN_PATCH_PX = 3            # rule of thumb: the target should cover at least ~3 x 3 pixels

CSV_FIELDS = ["session", "camera", "reference", "patch_mm", "asset", "n", "time", "distance_m", "patch_px", "box_x", "box_y", "box_w", "box_h",
              "probe", "probe_std", "probe_slope_c_per_min", "cam_mean", "cam_max", "cam_centre",
              "cam_noise", "background", "ambient", "error_mean", "error_max", "loss_mean", "loss_max",
              "n_frames", "n_probe", "warnings"]


class CalibrationError(ValueError):
    """Shown to the user as-is."""


def _r(v, nd=2):
    return None if v is None or not math.isfinite(v) else round(float(v), nd)


class Calibration:
    def __init__(self, data_dir: Path, store, sensors_cfg: list):
        self.dir = Path(data_dir) / "calibration"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.store = store
        self.sensors = {s["id"]: s for s in sensors_cfg}
        self._lock = threading.Lock()  # session files
        self._cap = None                # the capture in progress (only one at a time)
        self._cap_lock = threading.Lock()

    # ------------------------------------------------------------- cameras
    def cameras(self) -> list[dict]:
        """Sensors that send images, with their field of view (None = unknown, no patch_px)."""
        snap = self.store.snapshot()
        out = []
        for s in snap["sensors"]:
            for f in s["frames"]:
                out.append({"point": f["point_id"], "label": s["label"], "shape": f["shape"],
                            "hfov_deg": self._hfov(s["id"])})
        return out

    def _hfov(self, sensor_id: str):
        cfg = self.sensors.get(sensor_id, {})
        v = cfg.get("hfov_deg", DEFAULT_HFOV.get(cfg.get("type")))
        return float(v) if v else None

    # ------------------------------------------------------------- sessions
    def create(self, name: str, camera: str, probe: str, patch_mm: float, notes: str, asset: dict | None) -> dict:
        if not camera or "." not in camera:
            raise CalibrationError("pick a camera")
        if not probe:
            raise CalibrationError("pick a reference thermocouple")
        try:
            patch_mm = float(patch_mm)
        except (TypeError, ValueError):
            raise CalibrationError("patch size must be a number (mm)")
        if not 1 <= patch_mm <= 1000:
            raise CalibrationError("patch size should be between 1 and 1000 mm")
        asset = asset or {}
        labels = {p["point"]: p["label"] for p in asset.get("probes", [])}
        name = (name or "").strip()[:80] or "calibration"
        sid = datetime.now().strftime("%Y%m%d-%H%M%S") + "_" + slugify(name)
        ambient = (asset.get("ambient") or [None])[0]
        session = {
            "id": sid,
            "name": name,
            "created": datetime.now(timezone.utc).isoformat(),
            "camera": camera,
            "hfov_deg": self._hfov(camera.split(".")[0]),
            "probe": probe,
            "probe_label": labels.get(probe, probe),
            "ambient_point": ambient,
            "patch_mm": patch_mm,
            "asset_id": asset.get("id"),
            "asset_name": asset.get("name"),
            "notes": (notes or "").strip()[:2000],
            "points": [],
        }
        with self._lock:
            (self.dir / sid).mkdir()
            self._write(session)
        return session

    def list(self) -> list[dict]:
        out = []
        for p in sorted(self.dir.glob("*/session.json"), reverse=True):
            s = json.loads(p.read_text())
            out.append({k: s[k] for k in ("id", "name", "created", "camera", "probe_label", "patch_mm", "asset_name")}
                       | {"points": len(s["points"])})
        return out

    def get(self, sid: str) -> dict:
        path = self._dir(sid) / "session.json"
        if not path.exists():
            raise CalibrationError(f"no calibration session '{sid}'")
        return json.loads(path.read_text())

    def delete(self, sid: str):
        with self._lock:
            shutil.rmtree(self._dir(sid), ignore_errors=True)

    def delete_point(self, sid: str, n: int):
        with self._lock:
            s = self.get(sid)
            s["points"] = [p for p in s["points"] if p["n"] != n]
            (self._dir(sid) / f"p{n:03d}.npy").unlink(missing_ok=True)
            self._write(s)

    def csv(self, sid: str) -> str:
        s = self.get(sid)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(CSV_FIELDS)
        for p in s["points"]:
            row = dict(p, session=s["name"], camera=s["camera"], reference=f"{s['probe_label']} ({s['probe']})",
                       patch_mm=s["patch_mm"], asset=s.get("asset_name"), box_x=p["box"][0], box_y=p["box"][1], box_w=p["box"][2], box_h=p["box"][3],
                       warnings="; ".join(p["warnings"]))
            w.writerow(["" if row.get(k) is None else row.get(k) for k in CSV_FIELDS])
        return buf.getvalue()

    def _dir(self, sid: str) -> Path:
        if not SESSION_ID_RE.match(sid or ""):
            raise CalibrationError("bad session id")
        return self.dir / sid

    def _write(self, s: dict):
        tmp = self._dir(s["id"]) / "session.json.tmp"
        tmp.write_text(json.dumps(s, indent=2))
        tmp.replace(self._dir(s["id"]) / "session.json")  # never leaves a half-written file

    # ------------------------------------------------------------- the maths
    @staticmethod
    def parse_box(box, shape) -> tuple[int, int, int, int]:
        """box = [x, y, w, h] in camera pixels (x, y = top-left). Clipped to the image."""
        try:
            x, y, w, h = (int(v) for v in box)
        except (TypeError, ValueError):
            raise CalibrationError("box must be x,y,w,h in pixels")
        rows, cols = shape
        w, h = max(1, min(w, MAX_BOX_PX)), max(1, min(h, MAX_BOX_PX))
        x, y = max(0, min(x, cols - w)), max(0, min(y, rows - h))
        return x, y, w, h

    @staticmethod
    def patch_px(patch_mm, distance_m, hfov_deg, width_px):
        """How many pixels wide the patch should look at this distance (None if unknown)."""
        if not (hfov_deg and distance_m and distance_m > 0):
            return None
        pixel_mm = 2 * distance_m * 1000 * math.tan(math.radians(hfov_deg) / 2) / width_px
        return patch_mm / pixel_mm

    @staticmethod
    def box_stats(data: np.ndarray, box, patch_px=None) -> dict:
        """Box mean/max/centre, plus the background: the median of a ring of pixels just outside
        the patch. The ring starts outside the expected patch size (not just outside the box), so
        a box smaller than the patch doesn't count patch pixels as background."""
        x, y, w, h = box
        roi = data[y:y + h, x:x + w]
        cx, cy = x + (w - 1) / 2, y + (h - 1) / 2
        inner = max(w, h, patch_px or 0) / 2 + 0.5        # half-size of the area to leave out
        outer = inner + RING_PX
        yy, xx = np.mgrid[0:data.shape[0], 0:data.shape[1]]
        dist = np.maximum(abs(xx - cx), abs(yy - cy))     # square rings, like the box
        ring = data[(dist > inner) & (dist <= outer)]
        return {
            "cam_mean": float(roi.mean()),
            "cam_max": float(roi.max()),
            "cam_centre": float(data[int(round(cy)), int(round(cx))]),
            "background": float(np.median(ring)) if ring.size else None,
        }

    @staticmethod
    def errors(probe, cam_mean, cam_max, background) -> dict:
        out = {"error_mean": cam_mean - probe, "error_max": cam_max - probe, "loss_mean": None, "loss_max": None}
        if background is not None and abs(probe - background) >= MIN_CONTRAST_C:
            out["loss_mean"] = (probe - cam_mean) / (probe - background)
            out["loss_max"] = (probe - cam_max) / (probe - background)
        return out

    # ------------------------------------------------------------- live view
    def live(self, sid: str, box, distance_m) -> dict:
        """Latest numbers for the box the user has placed (polled by the page ~2 times a second)."""
        s = self.get(sid)
        found = self.store.frame(s["camera"])
        if found is None:
            raise CalibrationError("no image from the camera yet")
        data = found[0]
        b = self.parse_box(box, data.shape)
        ppx = self.patch_px(s["patch_mm"], distance_m, s["hfov_deg"], data.shape[1])
        out = {"box": list(b), "shape": list(data.shape), "patch_px": _r(ppx, 1)} | self.box_stats(data, b, ppx)
        out["probe"] = self.store.latest(s["probe"])
        out["ambient"] = self.store.latest(s["ambient_point"]) if s["ambient_point"] else None
        if out["probe"] is not None:
            out |= self.errors(out["probe"], out["cam_mean"], out["cam_max"], out["background"])
        out["warnings"] = self._warnings(b, ppx, None, out["probe"], out["background"])
        return {k: (_r(v, 3) if k.startswith("loss") else _r(v)) if isinstance(v, float) else v
                for k, v in out.items()}

    @staticmethod
    def _warnings(box, ppx, slope, probe, background) -> list[str]:
        w = []
        if ppx is not None and ppx < WARN_MIN_PATCH_PX:
            w.append(f"patch only ~{ppx:.1f} px wide (under {WARN_MIN_PATCH_PX}): expect large errors")
        if ppx is not None and max(box[2], box[3]) > ppx + 0.5:
            w.append("box is bigger than the patch, so it includes background")
        if slope is not None and abs(slope) > WARN_SLOPE_C_PER_MIN:
            w.append(f"temperature changing {slope:+.1f} degC/min during capture")
        if probe is not None and background is not None and abs(probe - background) < MIN_CONTRAST_C:
            w.append("patch and background within 3 degC: loss % not meaningful")
        return w

    # ------------------------------------------------------------- capture
    def capture(self, sid: str, distance_m, box, seconds: float = 10) -> dict:
        """Collects every camera frame and TC reading for `seconds`, then saves one point.
        Blocks for the duration (the page shows a countdown)."""
        s = self.get(sid)
        try:
            distance_m = float(distance_m)
        except (TypeError, ValueError):
            raise CalibrationError("enter the distance in metres")
        if not 0.05 <= distance_m <= 50:
            raise CalibrationError("distance should be between 0.05 and 50 m")
        seconds = max(3.0, min(float(seconds or 10), 60.0))

        cap = {"camera": s["camera"], "probe": s["probe"], "ambient": s["ambient_point"],
               "frames": [], "probe_v": [], "ambient_v": [], "until": time.time() + seconds}
        with self._cap_lock:
            if self._cap:
                raise CalibrationError("a capture is already running")
            self._cap = cap
        try:
            time.sleep(seconds)
        finally:
            with self._cap_lock:
                self._cap = None

        if len(cap["frames"]) < 3:
            raise CalibrationError(f"only {len(cap['frames'])} camera frames arrived; is the camera LIVE?")
        if len(cap["probe_v"]) < 2:
            raise CalibrationError("no thermocouple readings arrived; is the TC-08 LIVE?")

        stack = np.stack(cap["frames"])
        mean_frame = stack.mean(axis=0).astype(np.float32)
        b = self.parse_box(box, mean_frame.shape)
        ppx = self.patch_px(s["patch_mm"], distance_m, s["hfov_deg"], mean_frame.shape[1])
        stats = self.box_stats(mean_frame, b, ppx)
        x, y, w, h = b
        per_frame = stack[:, y:y + h, x:x + w].mean(axis=(1, 2))   # box mean in each frame

        t, v = np.array(cap["probe_v"]).T
        probe = float(v.mean())
        slope = float(np.polyfit(t - t[0], v, 1)[0] * 60) if np.ptp(t) > 0 else 0.0
        ambient = float(np.mean([a for _, a in cap["ambient_v"]])) if cap["ambient_v"] else None

        with self._lock:
            s = self.get(sid)  # re-read: a point may have been deleted meanwhile
            n = max((p["n"] for p in s["points"]), default=0) + 1
            point = {
                "n": n,
                "time": datetime.now(timezone.utc).isoformat(),
                "distance_m": distance_m,
                "box": list(b),
                "patch_px": _r(ppx, 1),
                "seconds": seconds,
                "n_frames": len(stack),
                "n_probe": len(v),
                "probe": _r(probe),
                "probe_std": _r(float(v.std())),
                "probe_slope_c_per_min": _r(slope),
                "cam_mean": _r(stats["cam_mean"]),
                "cam_max": _r(stats["cam_max"]),
                "cam_centre": _r(stats["cam_centre"]),
                "cam_noise": _r(float(per_frame.std())),   # how much the box mean wobbled frame to frame
                "background": _r(stats["background"]),
                "ambient": _r(ambient),
            }
            err = self.errors(probe, stats["cam_mean"], stats["cam_max"], stats["background"])
            point |= {k: _r(val, 3 if k.startswith("loss") else 2) for k, val in err.items()}
            point["warnings"] = self._warnings(b, ppx, slope, probe, stats["background"])
            np.save(self._dir(sid) / f"p{n:03d}.npy", mean_frame)
            s["points"].append(point)
            self._write(s)
        log.info("calibration %s: point %d at %.2f m, error %.2f degC", sid, n, distance_m, point["error_mean"])
        return point

    # ------------------------------------------------------------- store listener
    def on_frame(self, point_id, data, t):
        cap = self._cap
        if cap and point_id == cap["camera"] and t <= cap["until"]:
            cap["frames"].append(np.array(data, dtype=np.float32, copy=True))

    def on_readings(self, msgs):
        cap = self._cap
        if not cap:
            return
        now = time.time()
        for m in msgs:
            v = m.get("value")
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                continue
            if m["point_id"] == cap["probe"]:
                cap["probe_v"].append((now, float(v)))
            elif m["point_id"] == cap["ambient"]:
                cap["ambient_v"].append((now, float(v)))
