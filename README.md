# dt-edge

The **deploy repo** for the DT-TEO edge rig: reads the rig's sensors on a Raspberry Pi and shows them live on one web dashboard.

Experiments, documentation and research stay in the `virtual-DT` lab repo. Code moves here only once it works. Readings use the same **canonical message (v2)** as the v0.1 pipeline, so this repo can later publish to the gateway without changing any adapters.

```
sensors ──► adapter (one per type) ──► common reading (v0.1 canonical v2) ──► store ──► web dashboard
                                                                                  └──► later: MQTT → v0.1 gateway
```

| Sensor | Type | Connection |
|---|---|---|
| BME280 | `bme280` | I2C 0x77 |
| MLX90640 thermal camera | `mlx90640` | I2C 0x33 |
| FLIR Lepton 3.5 + PureThermal | `lepton` | USB |
| Pico TC-08 thermocouple logger | `tc08` | USB (Pico driver) |
| Tapo P110 smart plug | `tapo_p110` | Wi-Fi, read-only (`tapo` library) |
| Simulated sensor | `simulated` | none (for testing) |

---

## First-time setup on the Pi

```bash
git clone <this repo's URL> ~/dt-edge
cd ~/dt-edge
chmod +x setup.sh run.sh
./setup.sh
```

`setup.sh` installs the heavy libraries (NumPy, OpenCV, Flask) from **apt**, because pip can't build them on the Pi. It also turns on I2C at 400 kHz, installs the TC-08 driver if Pico's package source is set up, and creates the Python environment. Reboot if it tells you to.

**TC-08 only:** first add Pico's package source by following steps 1–3 for Debian at picotech.com/downloads/linux, then run `./setup.sh` again.

## Running it

```bash
cd ~/dt-edge
./run.sh
```

Then open **http://\<pi-address\>:8080** in a browser on the Pi or on any device on the same network. Run `hostname -I` on the Pi to see its address. Stop it with **Ctrl+C**, which also releases every device cleanly.

No hardware? Run `./run.sh --config demo.yaml` for simulated sensors only. This also works on a laptop: `pip install flask pyyaml numpy opencv-python`, then `python -m app.main --config demo.yaml`.

## Updating

```bash
cd ~/dt-edge && git pull
```

Then restart `./run.sh`. Only re-run `./setup.sh` if `requirements.txt` changed.

---

## Onboarding a new sensor

**1. Connect it and check the Pi can see it.**
I2C: `i2cdetect -y 1`. USB: `lsusb`. Camera: `v4l2-ctl --list-devices`.

**2. Write an adapter**, in `app/adapters/<name>.py`. Copy `bme280.py`, the simplest one. An adapter has three methods:

```python
class MySensorAdapter(Adapter):
    def connect(self):    # open the device; raise an exception if it isn't there
        ...
    def read(self):       # return a list of Reading (numbers) and/or Frame (images)
        return [Reading(self.point("temp"), 21.4, "DEG_C", now_utc(), source=self.source, label="Temperature")]
    def close(self):      # release the device (optional)
        ...
```

Units use QUDT ids, as in v0.1: `DEG_C`, `PERCENT_RH`, `HectoPA`, `W`, `KiloW-HR`. I2C sensors must use the shared bus and lock in `app/i2c.py`.

**3. Register it** with one line in `app/registry.py`.

**4. Add it to `sensors.yaml`:**

```yaml
  - id: my_sensor
    type: my_sensor_type
    label: What the dashboard shows
    poll_s: 1
```

**5. Test it on its own**, with the dashboard stopped:

```bash
venv/bin/python -m app.check my_sensor
```

This prints each reading exactly as the rest of the system will receive it.

**6. Run the dashboard.** The sensor gets its own card automatically. No front-end changes are needed.

### How errors are handled
Each sensor runs in its own thread. If a read fails 3 times in a row, that sensor is closed and reconnected every 5 seconds, while the others keep running. Each card shows a status:

| Status | Meaning |
|---|---|
| LIVE | Data arriving |
| WAITING | Started, no data yet |
| STALE | No new data for longer than `stale_after_s` |
| ERROR | Connecting or reading failed; the message is shown on the card |
| OFF | `enabled: false` in `sensors.yaml` |

---

## Calibrating the thermal camera (Calibrate tab)

Measures how far the camera is from a thermocouple, and how that changes with distance. Nothing here changes live readings; it only measures (details and maths: `app/calibration.py`).

**Set-up:** tape a matte black patch (e.g. 50 x 50 mm electrical tape) over a thermocouple on the asset, so the camera sees a surface it reads well. Keep the camera square on to the patch.

1. **New...** session: camera, reference thermocouple (from the asset's probes), patch width in mm.
2. Enter the **distance** (m) and **click the patch** on the image. The image shows real pixels; the dashed square is where the patch should be at that distance, the dotted ring is the background it gets blended with.
3. **Capture point** averages 10 s (TC, box mean/max, background) and saves it. Repeat at each distance, ideally at a steady temperature.
4. **Download CSV** for analysis.

| Column | Meaning |
|---|---|
| error | camera − thermocouple, degC |
| loss | (TC − camera) / (TC − background): the share of the patch-to-background difference the camera lost. 0 % = perfect, 100 % = reads like the background. Carries over to other assets |
| patch | how many pixels wide the patch should be, from `hfov_deg` in `sensors.yaml` (Lepton 3.5 = 57) |
| noise | how much the box average wobbled frame to frame |

Warnings flag a patch under ~3 px, a box bigger than the patch, a TC changing > 1 degC/min, and too little patch-to-background difference for loss to mean anything. Sessions are saved in `data/calibration/`, with the averaged image for each point (`p001.npy`) so the box can be re-picked later.

---

## Troubleshooting (lessons from the first rig setup)

| Problem | Fix |
|---|---|
| `No module named 'board'` etc. | Run through `./run.sh`, or activate the environment with `source venv/bin/activate` |
| `libopenblas.so.0` missing | `sudo apt install -y libopenblas-dev` |
| pip fails building numpy/opencv | Don't pip-install them; `setup.sh` gets them from apt |
| BME280 / MLX not found | `i2cdetect -y 1` should show 77 and 33. Chain Pi → BME280 → MLX (the MLX has one port, so it goes last). Check the BME280's green light |
| MLX very slow | The I2C speed line is missing from `/boot/firmware/config.txt`; re-run `setup.sh` and reboot |
| Lepton not found | Use a data USB-C cable (not charge-only); `lsusb` should show `1e4e:0100` |
| TC-08 "PicoSDK not found" | `echo /opt/picoscope/lib \| sudo tee /etc/ld.so.conf.d/picoscope.conf && sudo ldconfig` |
| TC-08 not found | Only one program can use it; close test scripts |
| Pasting into nano does nothing | Use Ctrl+Shift+V, or edit on your PC and `git pull` |
| BME280 reads warm | It's picking up heat from the Pi; mount it away from the Pi |
| Plug: "refused the KLAP login" / 403 | Leave **Third-Party Compatibility off** in the Tapo app; the plug then uses TPAP, which the `tapo` library handles. python-kasa can't (shows "Unsupported device … TPAP") |
| Plug: not found / timeout | Plug and Pi must be on the same Wi-Fi; hotspot IPs change, so re-check the plug's IP in the Tapo app (Device Info) and update `TAPO_HOST` in `.env` |

---

## The dashboard pages

| Page | What it's for |
|---|---|
| **Overview** | The rig at a glance on one screen, for the object under test: power & energy (or, on the test rig, a camera comparison), one thermal camera (click it for the temperature at any point), probe temperatures over time with heating rate next to a 2D drawing of the object (kettle / fan matrix / generic / your photo) showing each probe's live reading, and all room-air readings. Each panel has **Details** (big graph, min/max/mean, CSV of the time shown). The page scales with the window, so it fits one screen on a laptop or a big monitor |
| **Sensors** | Every sensor as a card with its status: the health check when setting up or debugging |
| **Recorded runs** | Downloads for every recorded test |

The header shows the asset (object under test), **Probes…**, **Record**, a **Live** indicator (amber/red with a count when a sensor needs a look; click it for the Sensors page) and, on Overview, the time range for the graphs (5 min to 3 hours, kept in memory on the Pi; recordings keep everything).

**Placing probes on the drawing:** Overview → **Move probes** → drag each dot to where the thermocouple is → **Save positions**. Labels arrange themselves either side of the object; dots, lines and labels use the same colours as the graph lines. Pick **Kettle drawing**, **Fan matrix**, **Generic outline** or **Uploaded photo** in the dropdown under the drawing (**Upload new photo…** is in the same list). With the kettle drawing, the **Water** slider sets how full it is; that's saved with each recording.

**No hardware / demo fallback:** `./run.sh --config demo.yaml` runs simulated sensors with the same names as the rig (thermocouples, plug switching ~2.9 kW, room air, camera), so the whole dashboard works with nothing plugged in.

The graphs use [uPlot](https://github.com/leeoniya/uPlot) (MIT), stored in `app/web/static/vendor/` so nothing is loaded from the internet.

## Recording a test run

1. Pick the **Asset** (the object under test) in the header. Use **Probes…** to tick which thermocouples are on it and name them (Water, Lid, ...).
2. Press **Record** in the header, type a run name (and notes), leave **Save thermal images** ticked if you want them, and press **Start recording**. The button turns into a red running timer.
3. While it runs, click the timer to add a **marker** for anything worth noting ("kettle switched off", "lid opened"). Plug on/off changes are logged automatically.
4. Click the timer → **Stop recording**. Then open **Recorded runs** to download it.

| Download | What it is |
|---|---|
| Excel CSV | One row per second, one column per sensor, named with the probe labels. Easiest to chart. |
| All readings | Every value exactly as it arrived: time, seconds since start, point, label, value, unit, quality |
| Events | Start/stop, your markers, plug on/off |
| Zip | The whole run folder, including `meta.json` (asset, probe labels and positions, sensor config, summary) and thermal images (`frames/*.npz`, load with `numpy.load`) |

Runs are saved on the Pi in `data/runs/<date-time>_<name>/`. **Delete** on the Recorded runs page removes a run permanently (it asks first; not possible while it's recording). Energy per run is worked out from the plug's power readings (area under the curve), which is much finer than the plug's own whole-Wh counter. A run stops itself after 12 hours, and won't start with less than 500 MB free.

## Assets and probes

`sensors.yaml` says what **hardware** is plugged in. An **asset profile** says what it **means** for the object under test. So moving the probes from the kettle to a toaster needs no config or code change:

- **New object:** Asset dropdown → **+ New asset…** (starts as a copy of the current one) → **Probes…** to tick and name its probes.
- **Thermocouples:** all 8 TC-08 sockets are read (`tc08.ch1` … `tc08.ch8`), plus `tc08.cold_junction`, the logger's own temperature. Tick the sockets you're using in **Probes…** and name them; unticked ones are dimmed on the Sensors page and left off the Overview.
- **The TC-08 cannot detect an unplugged probe.** An empty socket reads about the logger's own (cold junction) temperature, so it looks like a probe at room temperature. **Probes…** shows the logger temperature and marks sockets reading within 0.3 °C of it ("≈ logger"). If unsure which probe is in which socket, hold one tip in your fingers and watch which value rises.
- **Probe tips must not touch the water or other conductive parts of a powered appliance.** On this rig a probe in the kettle water caused jumps on all channels (the TC-08 is pushed out of its input range by the voltage difference), and it's an electrical safety risk. Use insulated (ungrounded-junction) probes if a reading in the water is needed.
- Profiles are kept in `data/assets/*.json`. `data/` isn't in Git, so dashboard edits never clash with `git pull`. The built-in profiles in `assets_default/` (Kettle, Test rig) are copied in when missing, so a new one appears after `git pull` + restart; existing profiles are never overwritten.
- Each probe also has a position on a picture of the object (x, y in %), set by dragging the dots on the Overview.

The asset can't be changed during a recording: the run saves the probe labels it started with.

## Test rig profile (fan matrix in the climate container)

Pick **Test rig** in the asset dropdown. Compared with the kettle:

- **Camera comparison** replaces Power & energy: every enabled camera's **max & mean** (mean dashed), or **min vs room air**, with the gap between the first two cameras in the tiles. The MLX90640 is much less accurate than the Lepton, so this is for comparing trends, not absolute values. The panel is set by `"panel": "compare"` in the profile (`"power"` = the plug panel).
- **Fan matrix drawing**: drag thermocouple dots onto the two fans (**Probes…** to add up to 8, **Move probes** to place them). The fans turn slowly while a recording runs (decoration only: nothing measures the real fans).
- **Range** (thermal panel): **Auto** or a **fixed** min/max in °C, so the colours stop re-scaling as the scene changes. Saved per profile and per camera. Only the colours change; temperatures and recordings don't.
- **Click the thermal image** for the temperature at that point (mean of 3 x 3 pixels on the Lepton, one pixel on the MLX). It updates every second; ✕ removes it.
- **Spots** (thermal panel): fixed points on the image that behave like extra thermocouples. **Spots** → click to add, drag to move, double-click to rename or delete → **Save**. They appear dashed in Thermal response and are **recorded** as `lepton.spot1`, `lepton.spot2`… (labelled with their names in the CSVs). Up to 8 per profile. Spot readings carry the camera's error (distance, emissivity): they are not corrected by the Calibrate page.

## Not built yet (deliberately)

- Markers and run start/stop drawn on the graphs
- Replaying a recorded run on the Overview (for now, open its Excel CSV)
- Publishing to MQTT / the v0.1 gateway
- Switching the Tapo plug. Control needs its own safety rules (operator enable, fail-safe off on stale data, logging) first
- Docker packaging
- Starting automatically on boot

## Security notes

- There is no login. Anyone on the same network can view the dashboard **and** start/stop recordings or edit assets, so run it on a trusted network only.
- Passwords (and the plug's IP) go in `.env`, which Git ignores. Never commit them.
