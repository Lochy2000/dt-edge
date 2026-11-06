"""Test-run recording: saves every reading of an experiment to the Pi's SD card.

One run = one folder in data/runs/, e.g. data/runs/20261106-141502_kettle-heat-up/
    meta.json      what was tested: name, notes, start/end, the asset profile (probe labels
                   and positions), the sensor config, and a summary (energy used, min/max per point)
    readings.csv   every reading as it arrived, one row per value (long format; camera
                   max/mean/min are kept at 2 per second, everything else in full):
                   time (UTC), t_s (seconds since start), point_id, label, value, unit, quality, qc
    events.csv     start/stop, markers you add ("lid opened"), and plug on/off changes
    frames/        optional: one thermal image per second per camera, as compressed NumPy files
                   (np.load(...)["frames"] -> array [n, rows, cols] in degC, ["t"] -> epoch seconds)

Exports (made on request from readings.csv, see server.py):
    wide CSV       one row per second, one column per sensor: easiest to open in Excel
                   (slower sensors' last value is repeated for up to 5 s to fill the gaps)
    zip            the whole folder

Safety: one run at a time; refuses to start with < 500 MB free; stops itself after
max_hours so a forgotten run can't fill the card. Files are flushed every 2 s, so a
power cut loses at most a couple of seconds.
"""
from __future__ import annotations

import csv
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

log = logging.getLogger("recorder")

RUN_ID_RE = re.compile(r"^\d{8}-\d{6}(_[a-z0-9-]+)?$")
CSV_FIELDS = ["time", "t_s", "point_id", "label", "value", "unit", "quality", "qc"]
MIN_FREE_BYTES = 500 * 1024 * 1024
FLUSH_EVERY_S = 2.0
FRAME_INTERVAL_S = 1.0
CAMERA_SUMMARY_INTERVAL_S = 0.5  # camera max/mean/min: 2 rows/s is plenty (full images are saved separately)
WIDE_FILL_S = 5  # wide CSV: repeat a sensor's last value for up to 5 s (sensors that report every 2 s)
FRAMES_PER_FILE = 60  # one .npz per minute per camera
UNIT_TEXT = {"DEG_C": "degC", "PERCENT_RH": "%RH", "HectoPA": "hPa", "W": "W", "KiloW-HR": "kWh"}  # for spreadsheet headers


class RecorderError(ValueError):
    """Shown to the user as-is (e.g. "already recording")."""


def _epoch(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


def _csv_value(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return 1 if v else 0  # 1 = on; numbers chart better in Excel than True/False
    return v


class Recorder:
    def __init__(self, data_dir: Path, site: str, sensors_cfg: list, max_hours: float = 6):
        self.dir = Path(data_dir) / "runs"
        self.exports = Path(data_dir) / "exports"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.exports.mkdir(parents=True, exist_ok=True)
        self.site, self.sensors_cfg, self.max_s = site, sensors_cfg, max_hours * 3600
        self._lock = threading.RLock()
        self._run: dict | None = None

    # ------------------------------------------------------------------ control
    def start(self, name: str, notes: str, asset: dict | None, frames: bool = True) -> dict:
        with self._lock:
            if self._run:
                raise RecorderError("already recording; stop the current run first")
            free = shutil.disk_usage(self.dir).free
            if free < MIN_FREE_BYTES:
                raise RecorderError(f"only {free // 2**20} MB free on the SD card")

            name = (name or "").strip()[:80] or "run"
            run_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "_" + slugify(name)
            d = self.dir / run_id
            d.mkdir()
            t0 = time.time()
            meta = {
                "id": run_id,
                "name": name,
                "notes": (notes or "").strip()[:2000],
                "site": self.site,
                "started": datetime.fromtimestamp(t0, timezone.utc).isoformat(),
                "ended": None,
                "asset": asset,
                "sensors": self.sensors_cfg,
                "frames": bool(frames),
            }
            f = open(d / "readings.csv", "w", newline="")
            ev = open(d / "events.csv", "w", newline="")
            self._run = {
                "id": run_id, "dir": d, "meta": meta, "t0": t0,
                "f": f, "w": csv.writer(f), "ev": ev, "evw": csv.writer(ev),
                "rows": 0, "last_flush": t0,
                "labels": {p["point"]: p["label"] for p in (asset or {}).get("probes", [])},
                "power_point": (asset or {}).get("power"),
                "state_point": (asset or {}).get("state"),
                "last_power": None, "energy_wh": 0.0, "last_state": None,
                "stats": {},  # point_id -> {label, unit, min, max, first, last}
                "frames_on": bool(frames), "frame_buf": {}, "frame_last": {}, "frame_files": {},
                "n_frames": 0, "markers": 0,
                "cameras": set(),     # sensor ids that send images (learnt from on_frame)
                "last_written": {},   # point_id -> t of last row written (camera throttle)
            }
            self._run["w"].writerow(CSV_FIELDS)
            self._run["evw"].writerow(["time", "t_s", "event"])
            self._write_meta()
            self._event("recording started")
            log.info("recording started: %s", run_id)
            return self.status()

    def stop(self, reason: str = "recording stopped") -> dict:
        with self._lock:
            r = self._run
            if not r:
                raise RecorderError("not recording")
            self._event(reason)
            for pid in list(r["frame_buf"]):
                self._flush_frames(pid)
            r["f"].close()
            r["ev"].close()
            ended = time.time()
            r["meta"].update({
                "ended": datetime.fromtimestamp(ended, timezone.utc).isoformat(),
                "duration_s": round(ended - r["t0"], 1),
                "rows": r["rows"],
                "frames_saved": r["n_frames"],
                "summary": {
                    "energy_wh": self._energy(r),
                    "points": r["stats"],
                },
            })
            self._write_meta()
            meta = r["meta"]
            self._run = None
            log.info("recording stopped: %s (%d rows)", meta["id"], meta["rows"])
            return meta

    def marker(self, text: str) -> None:
        with self._lock:
            if not self._run:
                raise RecorderError("not recording")
            text = (text or "").strip()[:200] or "marker"
            self._run["markers"] += 1
            self._event(text)

    def status(self) -> dict:
        with self._lock:
            r = self._run
            if not r:
                return {"recording": False}
            return {
                "recording": True,
                "id": r["id"],
                "name": r["meta"]["name"],
                "started": r["meta"]["started"],
                "elapsed_s": round(time.time() - r["t0"], 1),
                "rows": r["rows"],
                "frames": r["n_frames"],
                "markers": r["markers"],
                "energy_wh": self._energy(r),
                "max_s": self.max_s,
            }

    # --------------------------------------------- called by the store (sensor threads)
    def on_readings(self, msgs: list[dict]) -> None:
        with self._lock:
            r = self._run
            if not r:
                return
            for m in msgs:
                pid, value = m["point_id"], m["value"]
                t = _epoch(m["sensor_time"])
                label = r["labels"].get(pid) or m.get("label") or pid
                self._update_stats(r, pid, label, m.get("unit"), value)
                if pid.split(".", 1)[0] in r["cameras"]:
                    if t - r["last_written"].get(pid, 0) < CAMERA_SUMMARY_INTERVAL_S:
                        continue  # camera summaries arrive ~9/s; keep 2/s
                    r["last_written"][pid] = t
                r["w"].writerow([m["sensor_time"], round(t - r["t0"], 3), pid, label, _csv_value(value),
                                 m.get("unit") or "", m.get("quality") or "", ";".join(m.get("qc") or [])])
                r["rows"] += 1
                if pid == r["power_point"]:
                    self._integrate_power(r, t, value)
                if pid == r["state_point"] and value is not None and value != r["last_state"]:
                    if r["last_state"] is not None:
                        self._event(f"{label}: {'on' if value else 'off'}")
                    r["last_state"] = value
            now = time.time()
            if now - r["last_flush"] >= FLUSH_EVERY_S:
                r["f"].flush()
                r["ev"].flush()
                r["last_flush"] = now
            if now - r["t0"] > self.max_s:
                self.stop(f"auto-stopped after {self.max_s / 3600:g} h")

    def on_frame(self, point_id: str, data: np.ndarray, t: float) -> None:
        with self._lock:
            r = self._run
            if not r:
                return
            r["cameras"].add(point_id.split(".", 1)[0])
            if not r["frames_on"] or t - r["frame_last"].get(point_id, 0) < FRAME_INTERVAL_S:
                return
            r["frame_last"][point_id] = t
            r["frame_buf"].setdefault(point_id, []).append((t, data.astype(np.float16)))
            r["n_frames"] += 1
            if len(r["frame_buf"][point_id]) >= FRAMES_PER_FILE:
                self._flush_frames(point_id)

    # ------------------------------------------------------------ browsing runs
    def list_runs(self) -> list[dict]:
        active = self._run["id"] if self._run else None
        out = []
        for d in sorted(self.dir.iterdir(), reverse=True):
            meta_path = d / "meta.json"
            if not d.is_dir() or not meta_path.exists():
                continue
            try:
                m = json.loads(meta_path.read_text())
            except ValueError:
                continue
            size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
            out.append({
                "id": m["id"], "name": m["name"], "started": m["started"], "ended": m.get("ended"),
                "duration_s": m.get("duration_s"), "rows": m.get("rows"),
                "asset": (m.get("asset") or {}).get("name"),
                "energy_wh": (m.get("summary") or {}).get("energy_wh"),
                "frames": m.get("frames_saved"), "size_mb": round(size / 2**20, 1),
                "recording": m["id"] == active,
            })
        return out

    def run_dir(self, run_id: str) -> Path:
        d = self.dir / run_id
        if not RUN_ID_RE.match(run_id or "") or not d.is_dir():
            raise RecorderError(f"no run '{run_id}'")
        return d

    def is_active(self, run_id: str) -> bool:
        return bool(self._run and self._run["id"] == run_id)

    def wide_csv(self, run_id: str) -> str:
        """One row per second, one column per point (last value in each second).

        Sensors slower than 1/s (plug, room air: every 2 s) would leave every other row blank,
        which breaks spreadsheet line charts, so their last value is repeated for up to
        WIDE_FILL_S seconds. Longer gaps stay blank so real dropouts remain visible.
        """
        d = self.run_dir(run_id)
        columns: dict[str, str] = {}   # point_id -> header, in order of first appearance
        rows: dict[int, dict] = {}     # whole second -> {point_id: value}
        with open(d / "readings.csv", newline="") as f:
            for rec in csv.DictReader(f):
                pid = rec["point_id"]
                if pid not in columns:
                    unit = f" ({UNIT_TEXT.get(rec['unit'], rec['unit'])})" if rec["unit"] else ""
                    columns[pid] = f"{rec['label']}{unit} [{pid}]"
                sec = math.floor(float(rec["t_s"]))
                rows.setdefault(sec, {})[pid] = rec["value"]
        t0 = _epoch(json.loads((d / "meta.json").read_text())["started"])
        lines = [["time", "t_s", *columns.values()]]
        last: dict[str, tuple[int, str]] = {}  # point_id -> (second, value) last seen
        for sec in sorted(rows):
            iso = datetime.fromtimestamp(t0 + sec, timezone.utc).isoformat(timespec="seconds")
            row = []
            for pid in columns:
                if pid in rows[sec]:
                    last[pid] = (sec, rows[sec][pid])
                    row.append(rows[sec][pid])
                elif pid in last and sec - last[pid][0] <= WIDE_FILL_S:
                    row.append(last[pid][1])  # slower sensor: carry its last value forward
                else:
                    row.append("")            # no data for longer than WIDE_FILL_S: a real gap
            lines.append([iso, sec, *row])
        out = []
        w = csv.writer(_ListWriter(out))
        w.writerows(lines)
        return "".join(out)

    def zip_path(self, run_id: str) -> Path:
        d = self.run_dir(run_id)
        if self.is_active(run_id):
            raise RecorderError("stop the run before downloading it")
        base = self.exports / run_id
        return Path(shutil.make_archive(str(base), "zip", root_dir=d.parent, base_dir=d.name))

    # ------------------------------------------------------------------ helpers
    def _event(self, text: str) -> None:
        r = self._run
        now = time.time()
        r["evw"].writerow([datetime.fromtimestamp(now, timezone.utc).isoformat(), round(now - r["t0"], 3), text])
        r["ev"].flush()

    def _write_meta(self) -> None:
        r = self._run
        tmp = r["dir"] / "meta.tmp"
        tmp.write_text(json.dumps(r["meta"], indent=2, default=str))
        tmp.replace(r["dir"] / "meta.json")

    @staticmethod
    def _energy(r):
        """None (shown as "—") if no power readings arrived, e.g. the plug is off-line."""
        return round(r["energy_wh"], 2) if r["last_power"] is not None else None

    @staticmethod
    def _update_stats(r, pid, label, unit, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return
        s = r["stats"].get(pid)
        if s is None:
            r["stats"][pid] = {"label": label, "unit": unit, "min": value, "max": value, "first": value, "last": value}
        else:
            s["min"], s["max"], s["last"] = min(s["min"], value), max(s["max"], value), value

    @staticmethod
    def _integrate_power(r, t, watts):
        """Energy = area under the power curve (trapezoids). Far finer than the plug's whole-Wh counter."""
        if isinstance(watts, bool) or not isinstance(watts, (int, float)):
            return
        if r["last_power"] is not None:
            t_prev, w_prev = r["last_power"]
            dt = t - t_prev
            if 0 < dt < 30:  # skip gaps (e.g. plug offline) rather than guessing across them
                r["energy_wh"] += (w_prev + watts) / 2 * dt / 3600
        r["last_power"] = (t, watts)

    def _flush_frames(self, point_id: str) -> None:
        r = self._run
        buf = r["frame_buf"].pop(point_id, [])
        if not buf:
            return
        n = r["frame_files"].get(point_id, 0)
        r["frame_files"][point_id] = n + 1
        fdir = r["dir"] / "frames"
        fdir.mkdir(exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", point_id)
        np.savez_compressed(fdir / f"{safe}_{n:04d}.npz",
                            t=np.array([b[0] for b in buf]), frames=np.stack([b[1] for b in buf]))


class _ListWriter:
    """Lets csv.writer write into a list of strings."""

    def __init__(self, out: list):
        self.out = out

    def write(self, s: str):
        self.out.append(s)
