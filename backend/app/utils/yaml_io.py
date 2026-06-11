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
import shutil
from datetime import datetime, timezone
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedSeq

from app.models import CalibrationLoadResponse, CalibrationSavePayload

_yaml = YAML(typ="safe", pure=True)
_yaml.default_flow_style = False
_yaml.indent(mapping=2, sequence=4, offset=2)


def _is_json_path(p: Path) -> bool:
    return p.suffix.lower() == ".json"


def _intrix_to_K(value) -> list[list[float]] | None:
    try:
        vals = [float(x) for x in list(value)]
    except (TypeError, ValueError):
        return None
    if len(vals) != 4:
        return None
    fx, fy, cx, cy = vals
    return [[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]]


def _size2(value) -> list[int] | None:
    if isinstance(value, dict):
        value = [value.get("width") or value.get("w"), value.get("height") or value.get("h")]
    try:
        vals = list(value)
    except TypeError:
        return None
    if len(vals) < 2:
        return None
    try:
        w, h = int(float(vals[0])), int(float(vals[1]))
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    return [w, h]


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
    if "K" not in out and "intrix" in out:
        K = _intrix_to_K(out["intrix"])
        if K is not None:
            out["K"] = K

    # D — distortion coefficients (variable length)
    if "D" not in out:
        for k in ("dist_coeffs", "distortion_coeffs", "distortion_coefficients", "distortion_coeff"):
            if k in out:
                v = out[k]
                if isinstance(v, dict) and "data" in v:
                    v = v["data"]
                out["D"] = v
                break

    if "model" not in out and "distortion_model" in out:
        out["model"] = out["distortion_model"]

    # rms / reprojection error
    if "rms" not in out:
        for k in ("rms_error", "reprojection_error", "rms_pixels", "rms_px"):
            if k in out:
                out["rms"] = out[k]
                break

    # image_size — accept dict {width, height} too
    if "image_size" not in out and "resolution" in out:
        out["image_size"] = out["resolution"]
    if "image_size" not in out and ("image_width" in out and "image_height" in out):
        out["image_size"] = [out["image_width"], out["image_height"]]
    if "image_size" in out:
        size = _size2(out["image_size"])
        if size is not None:
            out["image_size"] = size

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


# ── MiBot camera_intrix.yaml export ───────────────────────────────────────────
# The robot's perception stack reads one shared file keyed by camera mount
# (head/left/right/back), each entry carrying [fx, fy, cx, cy] + distortion. A
# fisheye solve fills exactly one mount, so we MERGE into the existing file
# (preserving the other mounts and their hand-assigned `sn`) rather than
# overwriting it, and back the old file up first. Round-trip YAML keeps any
# comments / key order the file already had.
CAMERA_SLOTS = ("head", "left", "right", "back")
_DEFAULT_CAMERA_INTRIX_PATH = "/mibot_env/configs/camera_intrix.yaml"


def _camera_intrix_path(override: str | None) -> Path:
    return Path(override or os.environ.get("CALIB_CAMERA_INTRIX_PATH") or _DEFAULT_CAMERA_INTRIX_PATH)


def _flow_list(values: list) -> CommentedSeq:
    """A YAML sequence that renders inline ([a, b, c]) to match the file's style."""
    seq = CommentedSeq(values)
    seq.fa.set_flow_style()
    return seq


def _camera_sn(slot: str, configs_dir: Path) -> str | None:
    """Look up a mount's serial from the sibling camera_sn.yaml (slot → sn map)."""
    sn_file = configs_dir / "camera_sn.yaml"
    if not sn_file.exists():
        return None
    try:
        with sn_file.open("r") as f:
            data = _yaml.load(f) or {}
        v = data.get(slot) if isinstance(data, dict) else None
        return str(v) if v is not None else None
    except Exception:
        return None


_KEEP_BACKUPS = 2


def _prune_backups(out: Path, keep: int = _KEEP_BACKUPS) -> None:
    """Keep only the `keep` most recent `<file>.<stamp>.bak` siblings; the UTC
    stamp sorts lexically, so name order is recency order."""
    backups = sorted(out.parent.glob(out.name + ".*.bak"))
    for old in backups[:-keep]:
        try:
            old.unlink()
        except OSError:
            pass


def _camera_intrix_slots(data: dict) -> list[str]:
    return [
        slot for slot in CAMERA_SLOTS
        if isinstance(data.get(slot), dict) and "intrix" in data[slot]
    ]


def _normalize_camera_intrix_doc(data: dict, *, slot: str | None = None) -> dict:
    slots = _camera_intrix_slots(data)
    if not slots:
        return data
    if slot:
        if slot not in CAMERA_SLOTS:
            raise ValueError(f"unknown camera slot {slot!r}; expected one of {CAMERA_SLOTS}")
        if slot not in slots:
            raise ValueError(f"camera slot {slot!r} has no intrix entry")
        selected = slot
    else:
        selected = "head" if "head" in slots else slots[0]

    entry = dict(data[selected])
    normalized = _normalize_loaded(entry)
    normalized["camera_slot"] = selected
    normalized["camera_slots"] = slots
    normalized.setdefault("kind", "fisheye")
    if "sn" in entry:
        normalized["sn"] = entry["sn"]
    return normalized


def export_camera_intrinsics(
    slot: str,
    K,
    D,
    *,
    image_size=None,
    path: str | None = None,
) -> dict:
    """Merge one camera's fisheye intrinsics into the shared camera_intrix.yaml.

    `slot` ∈ CAMERA_SLOTS. Preserves every other mount; the target mount's `sn` is
    taken from the sibling camera_sn.yaml (falling back to any existing value).
    Backs the existing file up to `<file>.<UTC-stamp>.bak` (keeping the latest few)
    before writing. Returns {path, slot, backup}. Raises ValueError on a bad slot
    or missing K."""
    if slot not in CAMERA_SLOTS:
        raise ValueError(f"unknown camera slot {slot!r}; expected one of {CAMERA_SLOTS}")
    if not K or len(K) < 3:
        raise ValueError("missing camera matrix K — run a calibration first")

    out = _camera_intrix_path(path)
    rt = YAML()                       # round-trip: keep existing keys/order/comments
    rt.indent(mapping=4, sequence=6, offset=4)

    doc = None
    backup: Path | None = None
    if out.exists():
        with out.open("r") as f:
            doc = rt.load(f)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = out.with_name(out.name + f".{stamp}.bak")
        shutil.copy2(out, backup)
    if not isinstance(doc, dict):
        doc = {}

    fx, fy = float(K[0][0]), float(K[1][1])
    cx, cy = float(K[0][2]), float(K[1][2])
    size = _size2(image_size) if image_size is not None else None

    entry = doc.get(slot)
    if not isinstance(entry, dict):
        entry = {}
        doc[slot] = entry
    # sn from camera_sn.yaml; keep any existing value if that lookup misses.
    sn = _camera_sn(slot, out.parent)
    if sn is not None:
        entry["sn"] = sn
    else:
        entry.setdefault("sn", "")
    entry["intrix"] = _flow_list([round(fx, 6), round(fy, 6), round(cx, 6), round(cy, 6)])
    entry["distortion_coeff"] = _flow_list([round(float(x), 8) for x in (list(D) or [])])
    entry["distortion_model"] = "fisheye"
    if size is not None:
        entry["image_size"] = _flow_list(size)

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        rt.dump(doc, f)
    if backup is not None:
        _prune_backups(out)
    return {
        "path": str(out),
        "slot": slot,
        "backup": str(backup) if backup else None,
        "image_size": size,
    }


def load_calibration(path: str, *, slot: str | None = None) -> CalibrationLoadResponse:
    p = Path(path)
    with p.open("r") as f:
        text = f.read()
    if _is_json_path(p):
        data = json.loads(text) if text.strip() else {}
    else:
        data = _yaml.load(text) or {}
    if not isinstance(data, dict):
        data = {}
    if _camera_intrix_slots(data):
        data = _normalize_camera_intrix_doc(data, slot=slot)
    else:
        data = _normalize_loaded(data)
    kind = str(data.get("kind", "unknown"))
    return CalibrationLoadResponse(path=str(p), kind=kind, data=data)
