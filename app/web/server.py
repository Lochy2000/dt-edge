"""The dashboard web server.

Pages
  /                              live dashboard
  /runs                          list of recorded test runs, with downloads

Live data
  GET  /api/state                latest readings + status for every sensor, recording status, active asset
  GET  /api/frame/<id>.png       latest thermal image, coloured
  GET  /api/history?points=a,b&minutes=30    recent values for graphs (from RAM)

Assets (what the readings mean for the object under test)
  GET  /api/assets               all profiles + which one is active
  POST /api/assets               {"name": "Toaster", "copy_from": "kettle"} -> new profile
  PUT  /api/assets/<id>          save a profile (labels, probe positions, ...)
  POST /api/assets/active        {"id": "kettle"}
  POST /api/assets/<id>/image    upload a photo/drawing of the object (form field "file")
  GET  /api/assets/<id>/image

Recording
  POST /api/record/start         {"name": "...", "notes": "...", "frames": true}
  POST /api/record/stop
  POST /api/record/marker        {"text": "lid opened"}
  GET  /api/runs                 list of runs
  GET  /api/runs/<id>/meta.json | readings.csv | events.csv | wide.csv | download.zip

There is no login: anyone on the same network can view AND start/stop recordings or
edit assets. Run it on a trusted network only.
"""
import time

import cv2
import numpy as np
from flask import Flask, Response, abort, jsonify, render_template, request, send_file

from app.assets import AssetError
from app.recorder import RecorderError

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


def create_app(store, assets, recorder) -> Flask:
    app = Flask(__name__)

    # Mistakes in a request (bad asset id, already recording, ...) come back as
    # {"error": "..."} with status 400, and the dashboard shows the message.
    @app.errorhandler(AssetError)
    @app.errorhandler(RecorderError)
    def user_error(e):
        return jsonify(error=str(e)), 400

    def body() -> dict:
        return request.get_json(silent=True) or {}

    # ---------------------------------------------------------------- pages
    @app.get("/")
    def index():
        return render_template("index.html", site=store.site)

    @app.get("/runs")
    def runs_page():
        return render_template("runs.html", site=store.site)

    # ------------------------------------------------------------ live data
    @app.get("/api/state")
    def state():
        asset = assets.active()
        snap = store.snapshot(labels=assets.labels(asset))
        snap["recording"] = recorder.status()
        snap["asset"] = asset
        return jsonify(snap)

    @app.get("/api/frame/<point_id>.png")
    def frame(point_id):
        found = store.frame(point_id)
        if found is None:
            abort(404)
        data, lo, hi, smooth = found
        return Response(render_frame(data, lo, hi, smooth), mimetype="image/png",
                        headers={"Cache-Control": "no-store"})

    @app.get("/api/history")
    def history():
        points = [p for p in request.args.get("points", "").split(",") if p][:30]
        minutes = min(max(float(request.args.get("minutes", 30)), 1), 60)
        return jsonify(store.history.get(points, time.time() - minutes * 60))

    # --------------------------------------------------------------- assets
    @app.get("/api/assets")
    def list_assets():
        return jsonify(active=assets.active_id(), assets=assets.list())

    @app.post("/api/assets")
    def create_asset():
        b = body()
        return jsonify(assets.create(str(b.get("name", "")), b.get("copy_from")))

    @app.put("/api/assets/<asset_id>")
    def save_asset(asset_id):
        b = body()
        b["id"] = asset_id
        b["image"] = assets.get(asset_id).get("image")  # the picture only changes via upload
        return jsonify(assets.save(b))

    @app.post("/api/assets/active")
    def set_active_asset():
        if recorder.status()["recording"]:
            raise AssetError("can't change the asset during a recording")
        assets.set_active(str(body().get("id", "")))
        return jsonify(active=assets.active_id())

    @app.post("/api/assets/<asset_id>/image")
    def upload_image(asset_id):
        f = request.files.get("file")
        if f is None:
            raise AssetError("no file uploaded")
        return jsonify(assets.save_image(asset_id, f.read(), f.mimetype))

    @app.get("/api/assets/<asset_id>/image")
    def asset_image(asset_id):
        path = assets.image_path(asset_id)
        if path is None:
            abort(404)
        return send_file(path, max_age=0)

    # ------------------------------------------------------------ recording
    @app.post("/api/record/start")
    def record_start():
        b = body()
        return jsonify(recorder.start(str(b.get("name", "")), str(b.get("notes", "")),
                                      assets.active(), bool(b.get("frames", True))))

    @app.post("/api/record/stop")
    def record_stop():
        return jsonify(recorder.stop())

    @app.post("/api/record/marker")
    def record_marker():
        recorder.marker(str(body().get("text", "")))
        return jsonify(recorder.status())

    @app.get("/api/runs")
    def list_runs():
        return jsonify(recorder.list_runs())

    @app.get("/api/runs/<run_id>/<name>")
    def run_file(run_id, name):
        d = recorder.run_dir(run_id)
        if name in ("meta.json", "readings.csv", "events.csv"):
            return send_file(d / name, as_attachment=name != "meta.json",
                             download_name=f"{run_id}_{name}", max_age=0)
        if name == "wide.csv":
            return Response(recorder.wide_csv(run_id), mimetype="text/csv",
                            headers={"Content-Disposition": f'attachment; filename="{run_id}_wide.csv"'})
        if name == "download.zip":
            return send_file(recorder.zip_path(run_id), as_attachment=True,
                             download_name=f"{run_id}.zip", max_age=0)
        abort(404)

    return app
