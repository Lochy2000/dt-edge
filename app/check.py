"""Test ONE sensor on its own, before it goes on the dashboard.

    python -m app.check ambient          # sensor id from sensors.yaml
    python -m app.check tc08 -n 10       # take 10 readings

Prints each reading in the canonical message format, so you can see exactly
what the rest of the system will receive. Stop the dashboard first if it is
using the same device.
"""
import argparse
import json
import time

from app import registry
from app.config import ROOT, load_config, load_env
from app.record import Frame, now_utc


def main():
    p = argparse.ArgumentParser()
    p.add_argument("sensor_id")
    p.add_argument("-n", type=int, default=5, help="number of reads")
    p.add_argument("--config", default=str(ROOT / "sensors.yaml"))
    args = p.parse_args()

    load_env()
    cfg = load_config(args.config)
    match = [s for s in cfg["sensors"] if s["id"] == args.sensor_id]
    if not match:
        raise SystemExit(f"no sensor '{args.sensor_id}' in config (have: {[s['id'] for s in cfg['sensors']]})")
    s = match[0]

    adapter = registry.load(s["type"])(s)
    print(f"connecting to {s['id']} ({s['type']}) ...")
    adapter.connect()
    print("connected\n")
    try:
        for i in range(args.n):
            for item in adapter.read():
                if isinstance(item, Frame):
                    print(f"[frame] {item.point_id} shape={item.data.shape} "
                          f"min={item.data.min():.1f} max={item.data.max():.1f} degC")
                else:
                    print(json.dumps(item.to_message(cfg["site"], now_utc())))
            print()
            time.sleep(float(s.get("poll_s", 1)))
    finally:
        adapter.close()
        print("closed")


if __name__ == "__main__":
    main()
