"""Runs one adapter in its own thread: connect, read every poll_s, and recover from errors.

If reads keep failing, the runner closes the device and reconnects after a pause,
so one unplugged cable never takes the rest of the dashboard down.
"""
import logging
import threading
import time

log = logging.getLogger("runner")

FAILS_BEFORE_RECONNECT = 3
RECONNECT_WAIT_S = 5


class SensorRunner(threading.Thread):
    def __init__(self, adapter, store, poll_s: float):
        super().__init__(name=f"sensor-{adapter.id}", daemon=True)
        self.adapter, self.store, self.poll_s = adapter, store, poll_s
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    def run(self):
        sid = self.adapter.id
        connected, fails = False, 0
        while not self._stop_event.is_set():
            if not connected:
                try:
                    self.adapter.connect()
                    connected, fails = True, 0
                    log.info("%s: connected", sid)
                except Exception as e:  # noqa: BLE001 - any device error should be shown, not crash
                    self.store.set_error(sid, f"connect failed: {e}")
                    log.warning("%s: connect failed: %s", sid, e)
                    self._safe_close()
                    self._stop_event.wait(RECONNECT_WAIT_S)
                    continue

            started = time.time()
            try:
                items = self.adapter.read()
                if items:
                    self.store.update(sid, items)
                fails = 0
            except Exception as e:  # noqa: BLE001
                fails += 1
                self.store.set_error(sid, f"read failed: {e}")
                log.warning("%s: read failed (%d): %s", sid, fails, e)
                if fails >= FAILS_BEFORE_RECONNECT:
                    self._safe_close()
                    connected = False
                    self._stop_event.wait(RECONNECT_WAIT_S)
                    continue

            self._stop_event.wait(max(0.0, self.poll_s - (time.time() - started)))

        self._safe_close()
        log.info("%s: stopped", sid)

    def _safe_close(self):
        try:
            self.adapter.close()
        except Exception as e:  # noqa: BLE001
            log.debug("%s: close failed: %s", self.adapter.id, e)
