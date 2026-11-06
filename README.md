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
| Tapo P110 smart plug | `tapo_p110` | Wi-Fi, read-only, **untested** |
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

---

## Not built yet (deliberately)

- Graphs and history (nothing is saved)
- Publishing to MQTT / the v0.1 gateway
- Switching the Tapo plug. Control needs its own safety rules (operator enable, fail-safe off on stale data, logging) first
- Docker packaging
- Starting automatically on boot

## Security notes

- The dashboard is read-only and has no login. Anyone on the same network can view it, so run it on a trusted network only.
- Passwords go in `.env`, which Git ignores. Never commit them.
