"""Short-term memory: the last N minutes of every numeric reading, kept in RAM for the graphs.

Nothing here is saved to disk (recordings do that, see recorder.py). Readings are
bucketed to one value per point per `step_s` (default 1 s), so a camera summary that
arrives 10 times a second doesn't use 10x the memory. 60 minutes x 1 s = 3600 values
per point, which is tiny.
"""
from __future__ import annotations

import math
import threading
from collections import deque


class History:
    def __init__(self, minutes: float = 60, step_s: float = 1.0):
        self.step_s = step_s
        self.maxlen = int(minutes * 60 / step_s)
        self._lock = threading.Lock()
        self._series: dict[str, deque] = {}  # point_id -> deque of [t, value]

    def add(self, point_id: str, t: float, value) -> None:
        """t = epoch seconds. Booleans are stored as 1/0; text and missing values are skipped."""
        if isinstance(value, bool):
            value = 1.0 if value else 0.0
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            return
        bucket = math.floor(t / self.step_s) * self.step_s
        with self._lock:
            d = self._series.get(point_id)
            if d is None:
                d = self._series[point_id] = deque(maxlen=self.maxlen)
            if d and d[-1][0] == bucket:
                d[-1][1] = float(value)  # same second: keep the latest value
            else:
                d.append([bucket, float(value)])

    def get(self, point_ids: list[str], since: float) -> dict:
        """{point_id: {"t": [...], "v": [...]}} for values newer than `since` (epoch seconds)."""
        out = {}
        with self._lock:
            for pid in point_ids:
                rows = [r for r in self._series.get(pid, ()) if r[0] >= since]
                out[pid] = {"t": [r[0] for r in rows], "v": [round(r[1], 3) for r in rows]}
        return out
