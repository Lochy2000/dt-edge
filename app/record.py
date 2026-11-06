"""The common reading format.

Every adapter returns these, so nothing downstream ever sees vendor-specific data.
`Reading.to_message()` produces the same shape as the v0.1 canonical message (v2),
so when MQTT is added later the gateway receives exactly what it already expects.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np

SCHEMA_VERSION = 2  # matches the v0.1 canonical message version


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Reading:
    """One value from one point, e.g. ambient.air_temp = 21.6 DEG_C."""

    point_id: str                         # "<sensor id>.<metric>", e.g. "boiler.water"
    value: float | str | bool | None      # None only when quality is BAD
    unit: str | None = None               # QUDT id: DEG_C, PERCENT_RH, HectoPA, W, KiloW-HR
    sensor_time: datetime | None = None   # when it was measured (None = use arrival time)
    quality: str = "GOOD"                 # GOOD / SUSPECT / BAD
    qc: list[str] = field(default_factory=list)  # reasons, if quality isn't GOOD
    source: str | None = None             # e.g. "tc08:boiler"
    label: str | None = None              # display name only, not part of the message

    def to_message(self, site: str, ingest_time: datetime) -> dict:
        return {
            "v": SCHEMA_VERSION,
            "site": site,
            "point_id": self.point_id,
            "value": self.value,
            "unit": self.unit,
            "sensor_time": (self.sensor_time or ingest_time).isoformat(),
            "ingest_time": ingest_time.isoformat(),
            "quality": self.quality,
            "qc": self.qc or None,
            # The Pi stamps the time at the moment it reads the hardware, so this is
            # the measurement time. "gateway" means the time was filled in on arrival.
            "time_source": "device" if self.sensor_time else "gateway",
            "source": self.source,
        }


@dataclass
class Frame:
    """A thermal image: a 2-D grid of temperatures in degC.

    Frames are shown on the dashboard but are not canonical messages. Cameras also
    return a few Readings (min / mean / max), and those are what would be sent on.
    """

    point_id: str
    data: np.ndarray
    sensor_time: datetime
    label: str | None = None
