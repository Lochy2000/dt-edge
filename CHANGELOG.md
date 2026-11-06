# Changelog

## 2026-11-06 — Step 1: recording, assets, short-term memory
- **Test-run recording** (`app/recorder.py`): start/stop from the dashboard, markers, plug on/off events, optional thermal images (1/s). Saved on the SD card in `data/runs/`. Downloads: Excel CSV (1 row/s), all readings, events, zip. Run energy integrated from plug power.
- **Asset profiles** (`app/assets.py`, `assets_default/kettle.json`): what readings mean for the object under test (probe labels and positions, power, camera). Switch, create and edit from the dashboard; stored in `data/assets/`.
- **Short-term memory** (`app/history.py`): last 60 min of every value in RAM at 1 s, served at `/api/history`, ready for graphs.
- **TC-08 channels are now generic** (`tc08.ch1`...): `sensors.yaml` lists sockets and probe types; names come from the asset. **Sensor id renamed `boiler` → `tc08`.**
- **Plug IP moved to `.env` (`TAPO_HOST`)** so hotspot IP changes never touch `sensors.yaml`.
- Dashboard: asset picker, **Probes…** editor, recording bar, **Recorded runs** page (`controls.js`, `runs.js`, `runs.html`).
- `demo.yaml`: simulated 4-channel thermocouple logger for laptop testing.

## 2026-11-06 — Tapo plug via the `tapo` library
- **P110 adapter rewritten on `tapo` (>= 0.11.1) instead of python-kasa.** The rig's plug (firmware 1.4.0) reports the newer TPAP protocol, which python-kasa can't speak ("Unsupported device", and 403 when forcing KLAP). `tapo` handles TPAP and KLAP. Same point ids as before: `plug.on`, `plug.power` (W, from mW), `plug.energy_today` (kWh). (`app/adapters/tapo_p110.py`, `requirements-optional.txt`, README)
- Don't update the plug firmware without re-testing; later 1.4.x versions are reported to break local access.

## 2026-11-06 — review fixes (before first Pi deploy)
- **Bad thermal pixels no longer break the dashboard.** One NaN/inf pixel used to make `/api/state` invalid JSON, so every card showed "Lost connection", and the auto colour scale stayed NaN until restart. Bad pixels are now filled with the median of the good ones and the camera's max/mean/min are marked `SUSPECT` (`qc: bad_pixels`); an all-bad frame is skipped. (`app/adapters/thermal.py`, guard in `app/store.py`)
- **Quieter log.** Web-server request lines are hidden so sensor warnings are readable. (`app/main.py`)
- **Lepton sanity checks.** Clear error if OpenCV sends a colour image instead of raw 16-bit frames, or if temperatures are impossible (e.g. radiometry off). (`app/adapters/lepton.py`)
