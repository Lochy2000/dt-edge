"""The dashboard web server.

  /                     the dashboard page
  /api/state            latest readings + status for every sensor (JSON)
  /api/frame/<id>.png   latest thermal image, coloured
"""
import cv2
import numpy as np
from flask import Flask, Response, abort, jsonify, render_template

FRAME_WIDTH = 480  # pixels; images are scaled up to this width


def render_frame(data: np.ndarray, lo: float, hi: float, smooth: bool) -> bytes:
    norm = np.clip((data - lo) / max(hi - lo, 1e-6), 0, 1)
    img = (norm * 255).astype(np.uint8)
    h, w = img.shape
    scale = max(1, FRAME_WIDTH // w)
    img = cv2.resize(img, (w * scale, h * scale),
                     interpolation=cv2.INTER_CUBIC if smooth else cv2.INTER_NEAREST)
    ok, buf = cv2.imencode(".png", cv2.applyColorMap(img, cv2.COLORMAP_INFERNO))
    return buf.tobytes()


def create_app(store) -> Flask:
    app = Flask(__name__)

    @app.get("/")
    def index():
        return render_template("index.html", site=store.site)

    @app.get("/api/state")
    def state():
        return jsonify(store.snapshot())

    @app.get("/api/frame/<point_id>.png")
    def frame(point_id):
        found = store.frame(point_id)
        if found is None:
            abort(404)
        data, lo, hi, smooth = found
        return Response(render_frame(data, lo, hi, smooth), mimetype="image/png",
                        headers={"Cache-Control": "no-store"})

    return app
