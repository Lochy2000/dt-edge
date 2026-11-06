"""Shared helper for thermal cameras: turn one image into a Frame plus summary Readings."""
import numpy as np

from app.record import Frame, Reading


def frame_with_summary(adapter, data: np.ndarray, ts):
    # Cameras occasionally return NaN/inf pixels. One NaN would turn max/mean/min and the
    # colour scale into NaN, which breaks the dashboard's JSON. So:
    #   - no usable pixels at all -> skip this frame (the card goes STALE if it keeps happening)
    #   - some bad pixels        -> fill them with the median of the good ones, mark SUSPECT
    good = np.isfinite(data)
    if not good.any():
        return []
    quality, qc = "GOOD", []
    if not good.all():
        data = np.where(good, data, np.median(data[good])).astype(np.float32)
        quality, qc = "SUSPECT", ["bad_pixels"]

    src = adapter.source
    def summary(metric, value, label):
        return Reading(adapter.point(metric), round(float(value), 2), "DEG_C", ts, quality, list(qc),
                       source=src, label=label)

    return [
        Frame(adapter.point("image"), data, ts, label=adapter.cfg.get("label")),
        summary("max", data.max(), "Max"),
        summary("mean", data.mean(), "Average"),
        summary("min", data.min(), "Min"),
    ]
