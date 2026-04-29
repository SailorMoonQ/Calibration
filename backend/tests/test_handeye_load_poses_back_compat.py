"""_load_poses_json accepts both legacy {basename: [[4x4]]} and new
{basename: {T: [[4x4]], ts: <epoch_s>}} entry shapes."""
from __future__ import annotations

import json
import numpy as np
import pytest

from app.calib.handeye import _load_poses_json


def _eye4_list():
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def test_legacy_4x4_array_still_loads(tmp_path):
    p = tmp_path / "poses.json"
    p.write_text(json.dumps({"f1.png": _eye4_list()}))
    out = _load_poses_json(str(p))
    assert "f1.png" in out
    assert np.allclose(out["f1.png"], np.eye(4))


def test_legacy_3x4_array_still_loads(tmp_path):
    p = tmp_path / "poses.json"
    rows3x4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]
    p.write_text(json.dumps({"f1.png": rows3x4}))
    out = _load_poses_json(str(p))
    assert np.allclose(out["f1.png"], np.eye(4))


def test_new_dict_shape_loads(tmp_path):
    p = tmp_path / "poses.json"
    p.write_text(json.dumps({
        "f1.png": {"T": _eye4_list(), "ts": 1735689600.123},
        "f2.png": {"T": _eye4_list(), "ts": 1735689601.456},
    }))
    out = _load_poses_json(str(p))
    assert set(out.keys()) == {"f1.png", "f2.png"}
    assert np.allclose(out["f1.png"], np.eye(4))


def test_new_dict_without_ts_still_loads(tmp_path):
    """ts is optional in the new shape — recorder always writes it but a
    hand-edited file might omit it."""
    p = tmp_path / "poses.json"
    p.write_text(json.dumps({"f1.png": {"T": _eye4_list()}}))
    out = _load_poses_json(str(p))
    assert np.allclose(out["f1.png"], np.eye(4))


def test_new_dict_missing_T_rejected(tmp_path):
    p = tmp_path / "poses.json"
    p.write_text(json.dumps({"f1.png": {"ts": 1.0}}))
    with pytest.raises(ValueError, match="missing 'T'"):
        _load_poses_json(str(p))


def test_malformed_value_rejected(tmp_path):
    p = tmp_path / "poses.json"
    p.write_text(json.dumps({"f1.png": "not a matrix"}))
    with pytest.raises(ValueError):
        _load_poses_json(str(p))
