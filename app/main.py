"""Starts every enabled sensor and the dashboard.

    python -m app.main                      # uses sensors.yaml
    python -m app.main --config demo.yaml   # another config, e.g. simulated only
Then open http://<pi-address>:8080 in any browser on the same network.
"""
import argparse
import copy
import logging
from pathlib import Path

from app import registry
from app.assets import Assets
from app.calibration import Calibration
from app.config import ROOT, load_config, load_env
from app.history import History
from app.recorder import Recorder
from app.runner import SensorRunner
from app.store import Store
from app.web.server import create_app


def main():
    parser = argparse.ArgumentParser(description="DT-TEO edge rig: sensors + dashboard")
    parser.add_argument("--config", default=str(ROOT / "sensors.yaml"))
    parser.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = reachable from other devices on the network")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data", default=str(ROOT / "data"), help="where recordings and asset profiles are kept")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # The web server logs every request (~8/s per open tab for the camera images), which
    # buries the sensor warnings. Only show its warnings and errors.
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    log = logging.getLogger("main")
    load_env()
    cfg = load_config(args.config)

    data_dir = Path(args.data)
    store = Store(cfg["site"], float(cfg.get("stale_after_s", 5)), history=History(minutes=60))
    assets = Assets(data_dir, ROOT / "assets_default")
    recorder = Recorder(data_dir, cfg["site"], copy.deepcopy(cfg["sensors"]))
    store.listeners.append(recorder)
    calibration = Calibration(data_dir, store, copy.deepcopy(cfg["sensors"]))
    store.listeners.append(calibration)
    runners = []
    for s in cfg["sensors"]:
        enabled = s.get("enabled", True)
        store.register(s, enabled)
        if not enabled:
            log.info("%s: disabled in config", s["id"])
            continue
        try:
            adapter = registry.load(s["type"])(s)
        except Exception as e:  # e.g. a library for this sensor isn't installed
            store.set_error(s["id"], f"could not load adapter: {e}")
            log.error("%s: could not load adapter: %s", s["id"], e)
            continue
        runner = SensorRunner(adapter, store, float(s.get("poll_s", 1)))
        runner.start()
        runners.append(runner)

    log.info("dashboard on http://%s:%d", args.host, args.port)
    try:
        create_app(store, assets, recorder, calibration).run(host=args.host, port=args.port, threaded=True, use_reloader=False)
    finally:
        if recorder.status()["recording"]:
            recorder.stop("dashboard shut down")  # closes the files cleanly on Ctrl+C
        for r in runners:
            r.stop()
        for r in runners:
            r.join(timeout=3)  # lets each adapter close() its device cleanly


if __name__ == "__main__":
    main()
