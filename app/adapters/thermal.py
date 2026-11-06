"""Shared helper for thermal cameras: turn one image into a Frame plus summary Readings."""
import numpy as np

from app.record import Frame, Reading


def frame_with_summary(adapter, data: np.ndarray, ts):
    src = adapter.source
    return [
        Frame(adapter.point("image"), data, ts, label=adapter.cfg.get("label")),
        Reading(adapter.point("max"), round(float(data.max()), 2), "DEG_C", ts, source=src, label="Max"),
        Reading(adapter.point("mean"), round(float(data.mean()), 2), "DEG_C", ts, source=src, label="Average"),
        Reading(adapter.point("min"), round(float(data.min()), 2), "DEG_C", ts, source=src, label="Min"),
    ]
