"""Pico Technology USB TC-08 thermocouple logger (USB, 8 channels).

Needs Pico's driver (libusbtc08) and the picosdk Python wrapper; see README.
Only one program can use the TC-08 at a time, so close any test scripts first.
"""
import ctypes
import math

from app.adapters.base import Adapter
from app.record import Reading, now_utc


class TC08Adapter(Adapter):
    def connect(self):
        from picosdk.usbtc08 import usbtc08 as tc08

        self.tc08 = tc08
        self.handle = tc08.usb_tc08_open_unit()
        if self.handle <= 0:  # 0 = no unit found, negative = error
            self.handle = None
            raise RuntimeError("TC-08 not found (check USB; close other programs using it)")
        tc08.usb_tc08_set_mains(self.handle, 0 if int(self.cfg.get("mains_hz", 50)) == 50 else 1)

        # channels: which sockets have a probe plugged in, and its type (printed on the plug, usually K).
        #   channels: {1: K, 2: K}                    <- normal form; points become tc08.ch1, tc08.ch2
        #   channels: {1: {probe: K, label: Water}}   <- optional default label
        # What each probe MEANS (Water, Surface...) is set per asset on the dashboard, not here,
        # so moving a probe from the kettle to the toaster needs no config change.
        self.channels = {}
        for ch, c in (self.cfg.get("channels") or {}).items():
            c = c if isinstance(c, dict) else {"probe": str(c)}
            ch = int(ch)
            if not 1 <= ch <= 8:
                raise ValueError(f"TC-08 channel {ch} doesn't exist (1-8)")
            c.setdefault("name", f"ch{ch}")
            c.setdefault("label", f"Channel {ch}")
            self.channels[ch] = c
        for ch, c in self.channels.items():
            tc08.usb_tc08_set_channel(self.handle, ch, ctypes.c_int8(ord(str(c.get("probe", "K")).upper()[0])))
        self.units = tc08.USBTC08_UNITS["USBTC08_UNITS_CENTIGRADE"]

    def read(self):
        temps = (ctypes.c_float * 9)()
        overflow = ctypes.c_int16(0)
        ok = self.tc08.usb_tc08_get_single(self.handle, ctypes.byref(temps), ctypes.byref(overflow), self.units)
        if ok == 0:
            raise RuntimeError("TC-08 read failed")
        ts = now_utc()

        out = []
        for ch, c in self.channels.items():
            value, quality, qc = round(float(temps[ch]), 2), "GOOD", []
            if math.isnan(temps[ch]):
                value, quality, qc = None, "BAD", ["no_reading"]  # e.g. probe unplugged
            elif overflow.value & (1 << ch):
                quality, qc = "BAD", ["out_of_range"]
            out.append(Reading(self.point(c["name"]), value, "DEG_C", ts, quality, qc,
                               source=self.source, label=c.get("label", c["name"])))

        if self.cfg.get("show_cold_junction", False):
            out.append(Reading(self.point("cold_junction"), round(float(temps[0]), 2), "DEG_C", ts,
                               source=self.source, label="Logger internal"))
        return out

    def close(self):
        if getattr(self, "handle", None):
            self.tc08.usb_tc08_close_unit(self.handle)
            self.handle = None
