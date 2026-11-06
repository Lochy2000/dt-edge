"""A fake sensor with no hardware: a slowly heating and cooling temperature,
plus an optional thermal image with a moving hot spot.

Use it to test the dashboard on a laptop, or to try changes without the rig.
"""
import math
import random
import time

import numpy as np

from app.adapters.base import Adapter
from app.adapters.thermal import frame_with_summary
from app.record import Reading, now_utc


class SimulatedAdapter(Adapter):
    def connect(self):
        self.t0 = time.time()

    def read(self):
        t = time.time() - self.t0
        temp = 20 + 35 * (1 + math.sin(t / 30)) / 2 + random.gauss(0, 0.2)  # 20-55 degC cycle
        ts = now_utc()
        out = [Reading(self.point("temp"), round(temp, 2), "DEG_C", ts, source=self.source, label="Temperature")]

        if self.cfg.get("image", False):
            yy, xx = np.mgrid[0:24, 0:32]
            cx, cy = 16 + 8 * math.sin(t / 7), 12 + 4 * math.cos(t / 9)
            data = 21 + (temp - 20) * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / 20)
            out = frame_with_summary(self, data.astype(np.float32), ts) + out
        return out
