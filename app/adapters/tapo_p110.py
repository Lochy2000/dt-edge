"""TP-Link Tapo P110 smart plug (Wi-Fi): on/off state, power and energy. READ-ONLY.

Untested until the plug is set up. Before enabling it in sensors.yaml:
  1. Set the plug up in the Tapo phone app on the same Wi-Fi as the Pi
     and turn on Me > Third-Party Services > Third-Party Compatibility.
  2. Put the plug's IP in sensors.yaml (`host:`) and your login in .env.
  3. Test from the terminal first: kasa --host <ip> --username ... --password ... state

Switching the plug on/off is deliberately not here yet: control needs its own
safety rules (operator enable, fail-safe off, logging) and will be added separately.
"""
import asyncio
import os

from app.adapters.base import Adapter
from app.record import Reading, now_utc


class TapoP110Adapter(Adapter):
    def connect(self):
        from kasa import Credentials, Discover

        user, password = os.environ.get("TAPO_USER"), os.environ.get("TAPO_PASS")
        if not user or not password:
            raise RuntimeError("TAPO_USER / TAPO_PASS missing from .env")
        self.loop = asyncio.new_event_loop()
        self.dev = self.loop.run_until_complete(
            Discover.discover_single(self.cfg["host"], credentials=Credentials(user, password))
        )

    def read(self):
        from kasa import Module

        self.loop.run_until_complete(self.dev.update())
        ts = now_utc()
        out = [Reading(self.point("on"), bool(self.dev.is_on), None, ts, source=self.source, label="Power state")]
        if Module.Energy in self.dev.modules:
            e = self.dev.modules[Module.Energy]
            out.append(Reading(self.point("power"), round(float(e.current_consumption or 0), 1), "W", ts,
                               source=self.source, label="Power"))
            if e.consumption_today is not None:
                out.append(Reading(self.point("energy_today"), round(float(e.consumption_today), 3), "KiloW-HR", ts,
                                   source=self.source, label="Energy today"))
        return out

    def close(self):
        if getattr(self, "loop", None):
            try:
                self.loop.run_until_complete(self.dev.disconnect())
            except Exception:
                pass
            self.loop.close()
            self.loop = None
