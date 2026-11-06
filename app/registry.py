"""Maps the `type:` in sensors.yaml to an adapter class.

Adapters are imported only when used, so a missing library for one sensor
(e.g. the TC-08 driver) can't stop the others from starting.
To onboard a new sensor type, add one line here.
"""
import importlib

ADAPTERS = {
    "bme280": "app.adapters.bme280:BME280Adapter",
    "mlx90640": "app.adapters.mlx90640:MLX90640Adapter",
    "lepton": "app.adapters.lepton:LeptonAdapter",
    "tc08": "app.adapters.tc08:TC08Adapter",
    "tapo_p110": "app.adapters.tapo_p110:TapoP110Adapter",
    "simulated": "app.adapters.simulated:SimulatedAdapter",
}


def load(sensor_type: str):
    if sensor_type not in ADAPTERS:
        raise ValueError(f"unknown sensor type '{sensor_type}' (known: {', '.join(ADAPTERS)})")
    module_name, class_name = ADAPTERS[sensor_type].split(":")
    return getattr(importlib.import_module(module_name), class_name)
