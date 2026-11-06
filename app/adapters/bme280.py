"""BME280: air temperature, humidity and pressure (I2C, address 0x77 or 0x76)."""
from app import i2c
from app.adapters.base import Adapter
from app.record import Reading, now_utc


class BME280Adapter(Adapter):
    def connect(self):
        from adafruit_bme280 import basic

        with i2c.lock:
            self.dev = basic.Adafruit_BME280_I2C(i2c.bus(), address=int(self.cfg.get("address", 0x77)))

    def read(self):
        with i2c.lock:
            t, h, p = self.dev.temperature, self.dev.relative_humidity, self.dev.pressure
        ts = now_utc()
        return [
            Reading(self.point("air_temp"), round(t, 2), "DEG_C", ts, source=self.source, label="Air temperature"),
            Reading(self.point("humidity"), round(h, 1), "PERCENT_RH", ts, source=self.source, label="Humidity"),
            Reading(self.point("pressure"), round(p, 1), "HectoPA", ts, source=self.source, label="Pressure"),
        ]
