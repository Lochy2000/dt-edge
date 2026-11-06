"""One shared I2C bus for every I2C sensor.

I2C is a shared bus (BME280 at 0x77, MLX90640 at 0x33, ...). Each sensor runs in its
own thread, so the lock makes sure only one talks on the bus at a time.
"""
import threading

lock = threading.Lock()
_bus = None


def bus():
    global _bus
    if _bus is None:
        import board  # from adafruit-blinka; imported here so non-I2C setups don't need it

        _bus = board.I2C()
    return _bus
