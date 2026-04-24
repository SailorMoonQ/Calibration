"""Human-readable YAML round-trip for calibration results.

Schema intentionally flatter than the internal CalibrationResult so hand-editing stays easy.
Per-frame residuals are omitted from the on-disk form — those are solver artefacts, not calibration."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from ruamel.yaml import YAML

from app.models import CalibrationSavePayload, CalibrationLoadResponse

_yaml = YAML(typ="safe", pure=True)
_yaml.default_flow_style = False
_yaml.indent(mapping=2, sequence=4, offset=2)


def save_calibration(payload: CalibrationSavePayload) -> Path:
    r = payload.result
    doc: dict = {
        "kind": payload.kind,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rms": round(float(r.rms), 6),
        "image_size": list(r.image_size) if r.image_size else None,
    }
    if r.K is not None:
        doc["K"] = [[round(float(x), 6) for x in row] for row in r.K[:3]]
    if r.D is not None:
        doc["D"] = [round(float(x), 6) for x in r.D]
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

    out = Path(payload.path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        _yaml.dump(doc, f)
    return out


def load_calibration(path: str) -> CalibrationLoadResponse:
    p = Path(path)
    with p.open("r") as f:
        data = _yaml.load(f) or {}
    kind = str(data.get("kind", "unknown"))
    return CalibrationLoadResponse(path=str(p), kind=kind, data=data)
