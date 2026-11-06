"""FLIR Lepton 3.5 on a PureThermal board (USB, appears as a webcam).

`device: auto` finds the PureThermal by name, because on the Pi 5 its /dev/videoX
number isn't fixed. Set a number (e.g. `device: 0`) to force one.
"""
import glob

import numpy as np

from app.adapters.base import Adapter
from app.adapters.thermal import frame_with_summary
from app.record import now_utc


def find_purethermal() -> int:
    for path in sorted(glob.glob("/sys/class/video4linux/video*"), key=lambda p: int(p.rsplit("video", 1)[1])):
        try:
            with open(f"{path}/name") as f:
                if "PureThermal" in f.read():
                    return int(path.rsplit("video", 1)[1])
        except OSError:
            continue
    raise RuntimeError("PureThermal camera not found (check the USB cable; run: v4l2-ctl --list-devices)")


class LeptonAdapter(Adapter):
    def connect(self):
        import cv2

        dev = self.cfg.get("device", "auto")
        index = find_purethermal() if dev == "auto" else int(dev)
        self.cap = cv2.VideoCapture(index, cv2.CAP_V4L2)
        self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"Y16 "))  # raw temperatures
        self.cap.set(cv2.CAP_PROP_CONVERT_RGB, 0)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 160)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 120)
        if not self.cap.isOpened():
            raise RuntimeError(f"could not open /dev/video{index}")

    def read(self):
        ok, frame = self.cap.read()
        if not ok:
            raise RuntimeError("no frame from camera")
        # Raw Y16 frames are 16-bit. Anything else means OpenCV ignored the Y16 request and
        # sent a colour picture, which would otherwise show as nonsense temperatures.
        if frame.dtype != np.uint16:
            raise RuntimeError(f"camera sent {frame.dtype} {frame.shape}, not raw 16-bit (Y16) frames")
        # Raw values are 1/100ths of a kelvin; extra rows (telemetry) are dropped.
        data = frame.astype(np.float32).reshape(-1, 160)[:120] / 100 - 273.15
        # With radiometry off the camera sends raw 14-bit counts (~8000), which convert to about
        # -190 degC. Catch that, and any other impossible values, instead of displaying them.
        median = float(np.median(data))
        if not -40 < median < 600:
            raise RuntimeError(f"implausible temperatures (median {median:.0f} degC); is radiometry (TLinear) on?")
        return frame_with_summary(self, data, now_utc())

    def close(self):
        if getattr(self, "cap", None) is not None:
            self.cap.release()
