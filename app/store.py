"""Holds the latest readings from every sensor, and works out each sensor's status.

Status rules:
  OFF      - disabled in sensors.yaml
  WAITING  - started, no data yet
  LIVE     - data newer than stale_after_s
  STALE    - no new data for longer than stale_after_s
  ERROR    - the last attempt to connect or read failed
The store itself keeps only the latest value. Every new reading is also passed on to:
  history    - the last hour in RAM, for graphs (app/history.py)
  listeners  - e.g. the recorder, which writes test runs to disk (app/recorder.py)
"""
from __future__ import annotations

import logging
import math
import threading
import time

import numpy as np

from app.record import Frame, Reading, now_utc

SCALE_SMOOTHING = 0.1  # how fast the auto colour scale follows the image (0-1)
log = logging.getLogger("store")


class Store:
    def __init__(self, site: str, default_stale_s: float = 5, history=None):
        self.site = site
        self.default_stale_s = default_stale_s
        self.history = history
        self.listeners = []  # objects with on_readings(msgs) and on_frame(point_id, data, t)
        self._lock = threading.Lock()
        self._sensors: dict[str, dict] = {}

    # ---- called at start-up ----
    def register(self, cfg: dict, enabled: bool = True):
        poll = float(cfg.get("poll_s", 1))
        with self._lock:
            self._sensors[cfg["id"]] = {
                "id": cfg["id"],
                "label": cfg.get("label", cfg["id"]),
                "type": cfg["type"],
                "enabled": enabled,
                "stale_after": float(cfg.get("stale_after_s", max(self.default_stale_s, 3 * poll))),
                "scale": cfg.get("scale", "auto"),
                "smooth": bool(cfg.get("smooth", False)),
                "last_ok": None,
                "error": None,
                "error_time": None,
                "points": {},   # point_id -> canonical message (+ label)
                "frames": {},   # point_id -> {"frame": Frame, "lo": .., "hi": ..}
            }

    # ---- called by the sensor threads ----
    def update(self, sensor_id: str, items: list[Reading | Frame]):
        ingest = now_utc()
        msgs, frames = [], []
        with self._lock:
            s = self._sensors[sensor_id]
            for item in items:
                if isinstance(item, Frame):
                    self._update_frame(s, item)
                    frames.append(item)
                else:
                    msg = item.to_message(self.site, ingest)
                    msg["label"] = item.label or item.point_id
                    s["points"][item.point_id] = msg
                    msgs.append((msg, (item.sensor_time or ingest).timestamp()))
            s["last_ok"] = time.time()
            s["error"] = None

        # Outside the lock, so a slow disk write never holds up the dashboard.
        if self.history:
            for msg, t in msgs:
                self.history.add(msg["point_id"], t, msg["value"])
        for listener in self.listeners:
            try:
                if msgs:
                    listener.on_readings([m for m, _ in msgs])
                for fr in frames:
                    listener.on_frame(fr.point_id, fr.data, fr.sensor_time.timestamp())
            except Exception:  # noqa: BLE001 - a recorder problem must not stop the sensor
                log.exception("listener %s failed", type(listener).__name__)

    def set_error(self, sensor_id: str, error: str):
        with self._lock:
            s = self._sensors[sensor_id]
            s["error"], s["error_time"] = error, time.time()

    def _update_frame(self, s: dict, frame: Frame):
        entry = s["frames"].setdefault(frame.point_id, {"lo": None, "hi": None})
        entry["frame"] = frame
        if s["scale"] == "auto":
            lo, hi = float(frame.data.min()), float(frame.data.max())
            if not (math.isfinite(lo) and math.isfinite(hi)):
                return  # second line of defence: a NaN here would stick in the smoothed scale forever
            if entry["lo"] is None:
                entry["lo"], entry["hi"] = lo, hi
            entry["lo"] += SCALE_SMOOTHING * (lo - entry["lo"])
            entry["hi"] += SCALE_SMOOTHING * (hi - entry["hi"])
            entry["hi"] = max(entry["hi"], entry["lo"] + 1)
        else:  # fixed scale, e.g. scale: [20, 100]
            entry["lo"], entry["hi"] = float(s["scale"][0]), float(s["scale"][1])

    # ---- called by the web server ----
    def frame(self, point_id: str):
        with self._lock:
            for s in self._sensors.values():
                if point_id in s["frames"] and "frame" in s["frames"][point_id]:
                    e = s["frames"][point_id]
                    return e["frame"].data.copy(), e["lo"], e["hi"], s["smooth"]
        return None

    def snapshot(self, labels: dict | None = None) -> dict:
        """labels: optional point_id -> display name (from the active asset, e.g. tc08.ch1 -> "Water")."""
        now = time.time()
        with self._lock:
            sensors = [self._sensor_view(s, now) for s in self._sensors.values()]
        if labels:
            for s in sensors:
                s["points"] = [{**p, "label": labels[p["point_id"]]} if p["point_id"] in labels else p
                               for p in s["points"]]
        counts = {}
        for s in sensors:
            counts[s["status"]] = counts.get(s["status"], 0) + 1
        return {"site": self.site, "time": now_utc().isoformat(), "counts": counts, "sensors": sensors}

    def _sensor_view(self, s: dict, now: float) -> dict:
        if not s["enabled"]:
            status = "OFF"
        elif s["error"] and (s["last_ok"] is None or s["error_time"] >= s["last_ok"]):
            status = "ERROR"
        elif s["last_ok"] is None:
            status = "WAITING"
        elif now - s["last_ok"] > s["stale_after"]:
            status = "STALE"
        else:
            status = "LIVE"
        return {
            "id": s["id"],
            "label": s["label"],
            "type": s["type"],
            "status": status,
            "age_s": None if s["last_ok"] is None else round(now - s["last_ok"], 1),
            "error": s["error"],
            "points": [_json_safe(m) for m in s["points"].values()],
            "frames": [
                {"point_id": pid, "lo": round(e["lo"], 1), "hi": round(e["hi"], 1),
                 "shape": list(e["frame"].data.shape)}
                for pid, e in s["frames"].items() if "frame" in e
            ],
        }


def _json_safe(msg: dict) -> dict:
    v = msg.get("value")
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        msg = {**msg, "value": None}
    return msg
