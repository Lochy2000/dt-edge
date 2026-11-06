# Changelog

## 2026-11-06 — Kettle drawing next to the probe graph
- The asset drawing moved into **Thermal response**, beside the probe graph, so each line sits next to its dot. Layout: Power | Thermal camera on top; Thermal response (graph + drawing) | Environment (narrow column) below.
- Environment trend lines fill their tiles; fixed them being clipped at the bottom.

## 2026-11-06 — Dashboard cleanup
- **Overview fits on one screen** (laptop size and up): smaller tiles, charts fill their panels, the cumulative energy graph removed (energy stays as a number and in Open details), heating rate moved into the panel header. Smaller screens still scroll.
- **Record button in the header** (all pages) replaces the recording bar: opens a start dialog; while recording it shows a red timer and opens markers / stop.
- **2D kettle drawing** (`diagram.js`): built-in kettle and generic drawings, or an uploaded photo (`drawing` in the asset; existing kettle profiles are switched to the kettle drawing automatically). Labels laid out in columns either side, linked to dots by lines, bigger text; drag dots in Move probes.
- **Thermal image** no longer cropped; it shrinks to fit the panel.
- **Environment panel shows every room-air reading** (pressure is back).
- **All 8 TC-08 sockets** in `sensors.yaml`, plus the logger's internal (cold junction) temperature. The TC-08 can't detect unplugged probes: Probes… shows the logger temperature and flags sockets reading ≈ it; unticked sockets are dimmed on the Sensors page.

## 2026-11-06 — Step 2: new Overview layout
- **Overview page** (`overview.html`, `overview.js`, `charts.js`): four panels as in the mockup, all driven by the active asset: Power & energy (live W, energy this run / over the time shown, power and cumulative energy graphs), Thermal camera (one at a time, dropdown, full screen), Thermal response (all probes over time, heating/cooling rate of the main probe), Environment & asset (room air with sparklines, picture of the object with live, draggable probe dots). **Open details** per panel: big graph, min/max/mean, CSV of the time shown.
- **Pages**: Overview (`/`), Sensors (`/sensors`, the old cards view), Recorded runs. Shared header/recording bar/probe editor in `base.html`; header shows a Live / "n need a look" indicator.
- Charts: uPlot 1.6.32 (MIT) vendored in `static/vendor/`; times in 24 h UK format; power and energy axes start at 0.
- `/api/history?since=` for live graph updates (only new points).
- **Recordings**: Excel CSV repeats slower sensors' last value for up to 5 s (no more blank every other row); camera max/mean/min stored at 2/s instead of ~9/s.
- **Demo fallback**: `demo.yaml` simulates the rig with the same sensor ids (thermocouples, plug ~2.9 kW 2 min on / 3 min off, room air, camera).

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
