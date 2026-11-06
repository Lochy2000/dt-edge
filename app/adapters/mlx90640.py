"""MLX90640: 32x24 thermal camera (I2C, address 0x33)."""
import numpy as np

from app import i2c
from app.adapters.base import Adapter
from app.adapters.thermal import frame_with_summary
from app.record import now_utc

RATES = {1: "REFRESH_1_HZ", 2: "REFRESH_2_HZ", 4: "REFRESH_4_HZ", 8: "REFRESH_8_HZ"}


class MLX90640Adapter(Adapter):
    def connect(self):
        import adafruit_mlx90640 as mlx

        with i2c.lock:
            self.dev = mlx.MLX90640(i2c.bus())
            self.dev.refresh_rate = getattr(mlx.RefreshRate, RATES[int(self.cfg.get("refresh_hz", 4))])
        self.buf = [0.0] * 768

    def read(self):
        try:
            with i2c.lock:
                self.dev.getFrame(self.buf)
        except ValueError:
            return []  # the sensor occasionally returns a bad frame; skip it
        data = np.array(self.buf, dtype=np.float32).reshape(24, 32)
        return frame_with_summary(self, data, now_utc())
