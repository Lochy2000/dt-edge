"""The dashboard web server.

Pages
  /                              overview: power, thermal camera, probe graphs, asset picture
  /sensors                       every sensor as a card, with its status (health check view)
  /runs                          list of recorded test runs, with downloads
  /calibrate                     thermal camera calibration against a thermocouple (app/calibration.py)

Live data
  GET  /api/state                latest readings + status for every sensor, recording status, active asset
  GET  /api/frame/<id>.png       latest thermal image, coloured (?smooth=0 shows the real pixels)
  GET  /api/frame/<id>/at?x=&y=  temperature at a point on the image (x, y in % of the image)
  GET  /api/history?points=a,b&minutes=30    recent values for graphs (from RAM, up to 180 min)
  GET  /api/history?points=a,b&since=<epoch> only values newer than that (for live updates)

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
  DELETE /api/runs/<id>          permanently delete a run (not while it's recording)

Calibration (one session = one camera + one reference thermocouple + one patch size)
  GET  /api/calibration/cameras
  GET  /api/calibration/sessions                 list
  POST /api/calibration/sessions                 {"name", "camera", "probe", "patch_mm", "notes"}
  GET  /api/calibration/sessions/<id>            setup + captured points
  DELETE /api/calibration/sessions/<id>
  GET  /api/calibration/sessions/<id>/live?box=x,y,w,h&distance=1.5   live numbers for the box
  POST /api/calibration/sessions/<id>/capture    {"distance_m", "box": [x,y,w,h], "seconds"} (waits)
  DELETE /api/calibration/sessions/<id>/points/<n>
  GET  /api/calibration/sessions/<id>/points.csv

There is no login: anyone on the same network can view AND start/stop recordings or
edit assets. Run it on a trusted network only.
"""
import time

import cv2
import numpy as np
from flask import Flask, Response, abort, jsonify, render_template, request, send_file

from app.assets import AssetError
from app.calibration import CalibrationError
from app.recorder import RecorderError
from app.spots import value_at

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


def create_app(store, assets, recorder, calibration, spots=None) -> Flask:
    app = Flask(__name__)
    # browsers must re-check the dashboard's .js/.css on every load, so a git pull is never hidden by an old cached copy
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    def asset_changed():
        """The active asset (or its settings) changed: apply its camera ranges and spots now."""
        scales = (assets.active() or {}).get("camera_scale", {})
        for cam in store.camera_ids():
            store.set_scale(cam, scales.get(cam))  # None = the range in sensors.yaml
        if spots:
            spots.refresh()

    asset_changed()

    # Mistakes in a request (bad asset id, already recording, ...) come back as
    # {"error": "..."} with status 400, and the dashboard shows the message.
    @app.errorhandler(AssetError)
    @app.errorhandler(RecorderError)
    @app.errorhandler(CalibrationError)
    def user_error(e):
        return jsonify(error=str(e)), 400

    def body() -> dict:
        return request.get_json(silent=True) or {}

    # ---------------------------------------------------------------- pages
    @app.get("/")
    def index():
        return render_template("overview.html", site=store.site, page="overview")

    @app.get("/sensors")
    def sensors_page():
        return render_template("sensors.html", site=store.site, page="sensors")

    @app.get("/runs")
    def runs_page():
        return render_template("runs.html", site=store.site, page="runs")

    @app.get("/calibrate")
    def calibrate_page():
        return render_template("calibrate.html", site=store.site, page="calibrate")

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
        if request.args.get("smooth") == "0":
            smooth = False
        return Response(render_frame(data, lo, hi, smooth), mimetype="image/png",
                        headers={"Cache-Control": "no-store"})

    @app.get("/api/frame/<point_id>/at")
    def frame_at(point_id):
        found = store.frame(point_id)
        if found is None:
            abort(404)
        try:
            x, y = float(request.args["x"]), float(request.args["y"])
        except (KeyError, ValueError):
            return jsonify(error="x and y (in % of the image) are needed"), 400
        value, row, col = value_at(found[0], x, y)
        return jsonify(value=round(value, 2), row=row, col=col, shape=list(found[0].shape))

    @app.get("/api/history")
    def history():
        points = [p for p in request.args.get("points", "").split(",") if p][:30]
        if "since" in request.args:  # live update: just what's new (exclusive of `since`)
            return jsonify(store.history.get(points, float(request.args["since"]) + 0.001))
        minutes = min(max(float(request.args.get("minutes", 30)), 1), 180)
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
        saved = assets.save(b)
        asset_changed()
        return jsonify(saved)

    @app.post("/api/assets/active")
    def set_active_asset():
        if recorder.status()["recording"]:
            raise AssetError("can't change the asset during a recording")
        assets.set_active(str(body().get("id", "")))
        asset_changed()
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

    @app.delete("/api/runs/<run_id>")
    def delete_run(run_id):
        recorder.delete_run(run_id)
        return jsonify(deleted=run_id)

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

    # ---------------------------------------------------------- calibration
    @app.get("/api/calibration/cameras")
    def calib_cameras():
        return jsonify(calibration.cameras())

    @app.get("/api/calibration/sessions")
    def calib_list():
        return jsonify(calibration.list())

    @app.post("/api/calibration/sessions")
    def calib_create():
        b = body()
        return jsonify(calibration.create(str(b.get("name", "")), str(b.get("camera", "")), str(b.get("probe", "")),
                                          b.get("patch_mm", 50), str(b.get("notes", "")), assets.active()))

    @app.get("/api/calibration/sessions/<sid>")
    def calib_get(sid):
        return jsonify(calibration.get(sid))

    @app.delete("/api/calibration/sessions/<sid>")
    def calib_delete(sid):
        calibration.delete(sid)
        return jsonify(deleted=sid)

    @app.get("/api/calibration/sessions/<sid>/live")
    def calib_live(sid):
        box = request.args.get("box", "0,0,1,1").split(",")
        return jsonify(calibration.live(sid, box, request.args.get("distance", type=float)))

    @app.post("/api/calibration/sessions/<sid>/capture")
    def calib_capture(sid):
        b = body()
        return jsonify(calibration.capture(sid, b.get("distance_m"), b.get("box"), b.get("seconds", 10)))

    @app.delete("/api/calibration/sessions/<sid>/points/<int:n>")
    def calib_delete_point(sid, n):
        calibration.delete_point(sid, n)
        return jsonify(calibration.get(sid))

    @app.get("/api/calibration/sessions/<sid>/points.csv")
    def calib_csv(sid):
        return Response(calibration.csv(sid), mimetype="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{sid}_calibration.csv"'})

    return app
