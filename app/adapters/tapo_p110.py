"""TP-Link Tapo P110 smart plug (Wi-Fi): on/off state, power and energy. READ-ONLY.

Uses the `tapo` library (not python-kasa). From firmware 1.4.0 the P110 speaks a newer
protocol (TPAP) unless "Third-Party Compatibility" is switched on in the Tapo app, and
python-kasa can't speak TPAP. `tapo` >= 0.11.1 speaks both, so the plug works whichever
way that switch is set.

Before enabling it in sensors.yaml:
  1. Plug on the same Wi-Fi as the Pi. Find its IP with the Tapo app (Device Info).
  2. Put the IP (TAPO_HOST) and your Tapo app login in .env.
  3. Test:  venv/bin/python -m app.check plug
Don't update the plug's firmware without re-testing: past updates have broken local access.

Switching the plug on/off is deliberately not here yet: control needs its own
safety rules (operator enable, fail-safe off, logging) and will be added separately.
"""
import asyncio
import os

from app.adapters.base import Adapter
from app.record import Reading, now_utc


class TapoP110Adapter(Adapter):
    def connect(self):
        from tapo import ApiClient

        user, password = os.environ.get("TAPO_USER"), os.environ.get("TAPO_PASS")
        if not user or not password:
            raise RuntimeError("TAPO_USER / TAPO_PASS missing from .env")
        # The library is async; this thread gets its own event loop and runs each call to completion.
        self.loop = asyncio.new_event_loop()
        client = ApiClient(user, password, timeout_s=5)
        host = self.cfg.get("host") or os.environ.get("TAPO_HOST")
        if not host:
            raise RuntimeError("plug IP missing: set TAPO_HOST in .env")
        self.dev = self._run(client.p110(host))  # logs in; raises if unreachable or wrong login

    def _run(self, coro):
        return self.loop.run_until_complete(coro)

    def read(self):
        info = self._run(self.dev.get_device_info())
        usage = self._run(self.dev.get_energy_usage())
        ts = now_utc()

        # energy usage gives power in milliwatts (finer than get_current_power's whole watts)
        if usage.current_power is not None:
            watts = usage.current_power / 1000
        else:
            watts = float(self._run(self.dev.get_current_power()).current_power)

        src = self.source
        return [
            Reading(self.point("on"), bool(info.device_on), None, ts, source=src, label="Power state"),
            Reading(self.point("power"), round(watts, 1), "W", ts, source=src, label="Power"),
            Reading(self.point("energy_today"), round(usage.today_energy / 1000, 3), "KiloW-HR", ts,
                    source=src, label="Energy today"),
        ]

    def close(self):
        if getattr(self, "loop", None):
            self.loop.close()
            self.loop = None
