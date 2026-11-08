"""Camera spots: fixed points on a thermal image that are read like a thermocouple.

A spot is saved in the active asset profile (asset["spots"], see assets.py):
    {"id": 1, "camera": "lepton", "label": "Fan 1 centre", "x": 30.5, "y": 48.0}   # x, y = % of the image

Every time a camera sends an image, this works out each of its spots' temperature (mean of a
3 x 3 pixel patch on the Lepton, the single pixel on low-resolution cameras like the MLX90640)
and hands it to the store as a normal reading, point id <camera>.spot<id>, e.g. lepton.spot1.
So spots appear in /api/state, the graphs and recordings with no extra code.

Spot readings come from the camera, so they carry the camera's error (distance, emissivity);
they are not corrected by the Calibrate page.
"""
from __future__ import annotations

import logging
import time

import numpy as np

from app.assets import spot_point
from app.record import Reading, now_utc

log = logging.getLogger("spots")
ASSET_CACHE_S = 1.0  # re-read the active asset at most once a second (cameras send ~9 images/s)


def pixel_of(shape, x_pct: float, y_pct: float) -> tuple[int, int]:
    """% position on the image -> (row, col) of the pixel under it."""
    rows, cols = shape[:2]
    col = min(max(int(x_pct / 100 * cols), 0), cols - 1)
    row = min(max(int(y_pct / 100 * rows), 0), rows - 1)
    return row, col


def value_at(data: np.ndarray, x_pct: float, y_pct: float) -> tuple[float, int, int]:
    """Temperature at a % position: mean of a 3 x 3 patch on images 80 px wide or more, else one pixel."""
    row, col = pixel_of(data.shape, x_pct, y_pct)
    r = 1 if data.shape[1] >= 80 else 0
    patch = data[max(row - r, 0):row + r + 1, max(col - r, 0):col + r + 1]
    return float(np.mean(patch)), row, col


class Spots:
    def __init__(self, store, assets):
        self.store, self.assets = store, assets
        self._spots, self._loaded = [], 0.0

    def refresh(self):
        """Call after the asset changes, so new spots are used straight away."""
        self._loaded = 0.0

    def _current(self) -> list[dict]:
        if time.time() - self._loaded > ASSET_CACHE_S:
            try:
                asset = self.assets.active()
                self._spots = (asset or {}).get("spots", [])
            except Exception as e:  # noqa: BLE001 - a bad profile must not stop the camera
                log.warning("could not read spots: %s", e)
                self._spots = []
            self._loaded = time.time()
        return self._spots

    # ---- store listener ----
    def on_frame(self, point_id: str, data: np.ndarray, t: float) -> None:
        cam = point_id.split(".", 1)[0]
        mine = [s for s in self._current() if s["camera"] == cam]
        self.store.drop_points(cam, f"{cam}.spot", {spot_point(s) for s in mine})
        if not mine:
            return
        ts = now_utc()
        quality = "GOOD" if np.isfinite(data).all() else "SUSPECT"
        readings = []
        for s in mine:
            v, _, _ = value_at(data, s["x"], s["y"])
            readings.append(Reading(spot_point(s), round(v, 2), "DEG_C", ts, quality,
                                    [] if quality == "GOOD" else ["bad_pixels"],
                                    source=f"spot:{cam}", label=s["label"]))
        self.store.update(cam, readings)

    def on_readings(self, msgs) -> None:
        pass
