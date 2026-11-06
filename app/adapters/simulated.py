"""Fake sensors with no hardware, for testing the dashboard on a laptop or as a demo fallback.

`mode:` picks what it pretends to be (default `temp`):
  temp     one slowly heating/cooling temperature (point <id>.temp); `image: true` adds a thermal
           image with a moving hot spot; `channels: N` makes it an N-channel thermocouple logger
           (<id>.ch1 ... chN, ch1 hottest)
  plug     a smart plug switching a ~2.9 kW load: 2 min on, 3 min off (<id>.on, .power, .energy_today)
  ambient  room air: temperature, humidity, pressure (<id>.air_temp, .humidity, .pressure)

demo.yaml uses the same sensor ids as the real rig (tc08, plug, ambient, lepton), so the
default kettle asset works unchanged in demo mode.
"""
import math
import random
import time

import numpy as np

from app.adapters.base import Adapter
from app.adapters.thermal import frame_with_summary
from app.record import Reading, now_utc

PLUG_ON_S, PLUG_OFF_S, PLUG_W = 120, 180, 2900


class SimulatedAdapter(Adapter):
    def connect(self):
        self.t0 = time.time()
        self.energy_wh = 0.0
        self.last = None

    def read(self):
        mode = self.cfg.get("mode", "temp")
        t = time.time() - self.t0
        ts = now_utc()
        src = self.source
        if mode == "plug":
            return self._plug(t, ts, src)
        if mode == "ambient":
            return [
                Reading(self.point("air_temp"), round(19.5 + 0.3 * math.sin(t / 300) + random.gauss(0, 0.03), 2), "DEG_C", ts, source=src, label="Air temperature"),
                Reading(self.point("humidity"), round(72 + 1.5 * math.sin(t / 400) + random.gauss(0, 0.1), 1), "PERCENT_RH", ts, source=src, label="Humidity"),
                Reading(self.point("pressure"), round(1023 + random.gauss(0, 0.1), 1), "HectoPA", ts, source=src, label="Pressure"),
            ]

        temp = 20 + 35 * (1 + math.sin(t / 30)) / 2 + random.gauss(0, 0.2)  # 20-55 degC cycle
        out = [Reading(self.point("temp"), round(temp, 2), "DEG_C", ts, source=src, label="Temperature")]
        n = int(self.cfg.get("channels", 0))
        if n:
            out = [Reading(self.point(f"ch{i}"), round(20 + (temp - 20) * (1 - 0.2 * (i - 1)) + random.gauss(0, 0.1), 2),
                           "DEG_C", ts, source=src, label=f"Channel {i}") for i in range(1, n + 1)]
        if self.cfg.get("image", False):
            yy, xx = np.mgrid[0:24, 0:32]
            cx, cy = 16 + 8 * math.sin(t / 7), 12 + 4 * math.cos(t / 9)
            data = 21 + (temp - 20) * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / 20)
            out = frame_with_summary(self, data.astype(np.float32), ts) + out
        return out

    def _plug(self, t, ts, src):
        on = (t % (PLUG_ON_S + PLUG_OFF_S)) < PLUG_ON_S
        watts = PLUG_W + random.gauss(0, 15) if on else 0.4 + random.gauss(0, 0.05)
        if self.last is not None:
            self.energy_wh += (watts + self.last[1]) / 2 * (t - self.last[0]) / 3600
        self.last = (t, watts)
        return [
            Reading(self.point("on"), on, None, ts, source=src, label="Power state"),
            Reading(self.point("power"), round(watts, 1), "W", ts, source=src, label="Power"),
            Reading(self.point("energy_today"), round(self.energy_wh / 1000, 3), "KiloW-HR", ts, source=src, label="Energy today"),
        ]
