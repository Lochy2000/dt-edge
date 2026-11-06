"""The contract every sensor adapter follows.

To onboard a new sensor, copy this pattern into a new file:

    class MySensorAdapter(Adapter):
        def connect(self):   # open the device (called at start, and after errors)
            ...
        def read(self):      # return a list of Reading / Frame objects
            ...
        def close(self):     # release the device (optional)
            ...

then register it in app/registry.py and add an entry to sensors.yaml.
"""
from __future__ import annotations

from app.record import Frame, Reading


class Adapter:
    def __init__(self, cfg: dict):
        self.cfg = cfg            # this sensor's block from sensors.yaml
        self.id = cfg["id"]

    def point(self, metric: str) -> str:
        """Builds a point id, e.g. point("water") -> "boiler.water"."""
        return f"{self.id}.{metric}"

    @property
    def source(self) -> str:
        return f"{self.cfg['type']}:{self.id}"

    def connect(self) -> None:
        """Open the device. Raise an exception if it can't be reached."""

    def read(self) -> list[Reading | Frame]:
        """Take one set of readings. Return [] to skip a bad sample without failing."""
        raise NotImplementedError

    def close(self) -> None:
        """Release the device so the next run (or a reconnect) can open it."""
