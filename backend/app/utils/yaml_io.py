"""Human-readable YAML / JSON round-trip for calibration results.

Schema intentionally flatter than the internal CalibrationResult so hand-editing stays easy.
Per-frame residuals are omitted from the on-disk form — those are solver artefacts, not calibration.
Format is picked by file extension: .json → JSON, anything else → YAML.

Camera-intrinsic kinds (fisheye, intrinsics) export with the keys other tooling expects:
  model, image_size, pattern_size, square_size_m, num_detections, rms_error,
  camera_matrix, dist_coeffs, used_images
plus our additive `dataset_path` so the renderer can rehydrate the session. Other kinds
(extrinsics, handeye, chain) keep the legacy schema since they don't round-trip with
the same field names."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from ruamel.yaml import YAML

from app.models import CalibrationSavePayload, CalibrationLoadResponse

_yaml = YAML(typ="safe", pure=True)
_yaml.default_flow_style = False
_yaml.indent(mapping=2, sequence=4, offset=2)


def _is_json_path(p: Path) -> bool:
    return p.suffix.lower() == ".json"


def _normalize_loaded(data: dict) -> dict:
    """Map common alternative key names onto the canonical save schema.

    Different calibration tools (OpenCV examples, Kalibr forks, custom scripts) use
    different names for the same things. Renderer expects a single shape — `K`, `D`,
    `rms`, `image_size`, `frames` — so do the translation here in one place rather
    than peppering aliases through the UI."""
    if not isinstance(data, dict):
        return data
    out = dict(data)

    # K — camera intrinsics 3x3
    if "K" not in out and "camera_matrix" in out:
        cm = out["camera_matrix"]
        if isinstance(cm, dict) and "data" in cm:  # ROS camera_info layout
            flat = cm["data"]
            if len(flat) == 9:
                out["K"] = [flat[0:3], flat[3:6], flat[6:9]]
        else:
            out["K"] = cm

    # D — distortion coefficients (variable length)
    if "D" not in out:
        for k in ("dist_coeffs", "distortion_coeffs", "distortion_coefficients"):
            if k in out:
                v = out[k]
                if isinstance(v, dict) and "data" in v:
                    v = v["data"]
                out["D"] = v
                break

    # rms / reprojection error
    if "rms" not in out:
        for k in ("rms_error", "reprojection_error", "rms_pixels", "rms_px"):
            if k in out:
                out["rms"] = out[k]
                break

    # image_size — accept dict {width, height} too
    if "image_size" in out and isinstance(out["image_size"], dict):
        sz = out["image_size"]
        out["image_size"] = [sz.get("width") or sz.get("w"), sz.get("height") or sz.get("h")]
    if "image_size" not in out and ("image_width" in out and "image_height" in out):
        out["image_size"] = [out["image_width"], out["image_height"]]

    # frames meta — synthesize from used_images / num_detections when absent
    if "frames" not in out:
        used_imgs = out.get("used_images")
        n_det = out.get("num_detections")
        per_err = out.get("per_frame_errors") or []
        if used_imgs is not None or n_det is not None or per_err:
            out["frames"] = {
                "used": len(used_imgs) if isinstance(used_imgs, list) else (n_det or 0),
                "per_frame_err": list(per_err),
            }

    # kind — derive from `model` when not explicit
    if "kind" not in out and "model" in out:
        m = str(out["model"]).lower()
        if "fish" in m or "kannala" in m or "equidistant" in m:
            out["kind"] = "fisheye"
        elif "pinhole" in m or "plumb" in m:
            out["kind"] = "intrinsics"

    return out


_CAMERA_KINDS = ("fisheye", "intrinsics")


def _relativize_paths(paths: list[str], base: str | None) -> list[str]:
    """Return paths relative to `base` when every entry is inside `base`; else basenames."""
    if not paths:
        return []
    if base and all(os.path.isabs(p) and (p == base or p.startswith(base.rstrip("/") + "/")) for p in paths):
        return [os.path.relpath(p, base) for p in paths]
    return [os.path.basename(p) for p in paths]


def _build_camera_doc(payload: CalibrationSavePayload) -> dict:
    """Schema for camera intrinsics export — matches the HandEyeCalibration tool's shape."""
    r = payload.result
    model = "fisheye" if payload.kind == "fisheye" else "pinhole"
    doc: dict = {
        "model": model,
        "image_size": list(r.image_size) if r.image_size else None,
    }
    if payload.board is not None:
        doc["pattern_size"] = [int(payload.board.cols), int(payload.board.rows)]
        doc["square_size_m"] = round(float(payload.board.square), 6)
    doc["num_detections"] = len(r.detected_paths)
    doc["rms_error"] = round(float(r.rms), 6)
    if r.K is not None:
        doc["camera_matrix"] = [[round(float(x), 6) for x in row] for row in r.K[:3]]
    if r.D is not None:
        doc["dist_coeffs"] = [round(float(x), 6) for x in r.D]
    doc["used_images"] = _relativize_paths(list(r.detected_paths), payload.dataset_path)
    # --- additive extensions (not in the reference schema; ignored by other tools) ---
    if payload.dataset_path:
        doc["dataset_path"] = payload.dataset_path
    if r.per_frame_err:
        doc["per_frame_errors"] = [round(float(e), 6) for e in r.per_frame_err]
    if payload.notes:
        doc["notes"] = payload.notes
    return doc


def _build_legacy_doc(payload: CalibrationSavePayload) -> dict:
    """Legacy schema for kinds that don't have camera intrinsics (extrinsics, handeye, chain)."""
    r = payload.result
    doc: dict = {
        "kind": payload.kind,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rms": round(float(r.rms), 6),
        "image_size": list(r.image_size) if r.image_size else None,
    }
    if r.T is not None:
        doc["T"] = [[round(float(x), 6) for x in row] for row in r.T]
    if payload.board is not None:
        b = payload.board
        doc["board"] = {
            "type": b.type, "cols": b.cols, "rows": b.rows,
            "square": b.square, "marker": b.marker, "dictionary": b.dictionary,
        }
    if payload.dataset_path:
        doc["dataset_path"] = payload.dataset_path
    if payload.notes:
        doc["notes"] = payload.notes
    doc["frames"] = {
        "used": len(r.detected_paths),
        "per_frame_err": [round(float(e), 6) for e in r.per_frame_err],
    }
    return doc


def save_calibration(payload: CalibrationSavePayload) -> Path:
    if payload.kind in _CAMERA_KINDS and payload.result.K is not None:
        doc = _build_camera_doc(payload)
    else:
        doc = _build_legacy_doc(payload)

    out = Path(payload.path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        if _is_json_path(out):
            json.dump(doc, f, indent=2, sort_keys=False)
            f.write("\n")
        else:
            _yaml.dump(doc, f)
    return out


def load_calibration(path: str) -> CalibrationLoadResponse:
    p = Path(path)
    with p.open("r") as f:
        text = f.read()
    if _is_json_path(p):
        data = json.loads(text) if text.strip() else {}
    else:
        data = _yaml.load(text) or {}
    if not isinstance(data, dict):
        data = {}
    data = _normalize_loaded(data)
    kind = str(data.get("kind", "unknown"))
    return CalibrationLoadResponse(path=str(p), kind=kind, data=data)
