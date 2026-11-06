# Changelog

## 2026-11-06 — review fixes (before first Pi deploy)
- **Bad thermal pixels no longer break the dashboard.** One NaN/inf pixel used to make `/api/state` invalid JSON, so every card showed "Lost connection", and the auto colour scale stayed NaN until restart. Bad pixels are now filled with the median of the good ones and the camera's max/mean/min are marked `SUSPECT` (`qc: bad_pixels`); an all-bad frame is skipped. (`app/adapters/thermal.py`, guard in `app/store.py`)
- **Quieter log.** Web-server request lines are hidden so sensor warnings are readable. (`app/main.py`)
- **Lepton sanity checks.** Clear error if OpenCV sends a colour image instead of raw 16-bit frames, or if temperatures are impossible (e.g. radiometry off). (`app/adapters/lepton.py`)
