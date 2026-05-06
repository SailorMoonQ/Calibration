"""Tests for the /recording/import_file endpoint (json + yaml normalization)."""
from __future__ import annotations

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _identity_T():
    return np.eye(4).tolist()


def _write_json_recording(path, *, n=4, device="tracker_0"):
    doc = {
        "meta": {"kind": "vive", "n": n, "t_first": 1000.0, "t_last": 1000.0 + n * 0.1, "device": device},
        "samples": [{"ts": 1000.0 + i * 0.1, "T": _identity_T()} for i in range(n)],
    }
    with open(path, "w") as f:
        json.dump(doc, f)


def test_import_file_json_roundtrip(client, tmp_path):
    src = tmp_path / "rec.json"
    _write_json_recording(str(src), n=4, device="tracker_0")

    resp = client.post("/recording/import_file", json={
        "path": str(src),
        "format": "json",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["count"] == 4
    assert abs(body["t_first"] - 1000.0) < 1e-6
    assert abs(body["t_last"] - 1000.3) < 1e-6
    assert body["device"] == "tracker_0"
    # JSON inputs are returned as-is (no rewrite needed).
    assert body["path"] == str(src)


def _write_yaml_recording(path, *, n=3, device="eef_pose"):
    from ruamel.yaml import YAML
    _y = YAML(typ="safe", pure=True)
    doc = {
        "meta": {"kind": "umi", "n": n, "t_first": 2000.0, "t_last": 2000.0 + n * 0.1, "device": device},
        "samples": [{"ts": 2000.0 + i * 0.1, "T": _identity_T()} for i in range(n)],
    }
    with open(path, "w") as f:
        _y.dump(doc, f)


def test_import_file_yaml_normalizes_to_json(client, tmp_path):
    src = tmp_path / "rec.yaml"
    _write_yaml_recording(str(src), n=3, device="eef_pose")

    resp = client.post("/recording/import_file", json={
        "path": str(src),
        "format": "yaml",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["count"] == 3
    assert body["device"] == "eef_pose"
    # YAML inputs get rewritten to a .normalized.json sibling.
    assert body["path"].endswith(".normalized.json")

    with open(body["path"]) as f:
        data = json.load(f)
    assert data["meta"]["n"] == 3
    assert len(data["samples"]) == 3


def test_import_file_missing_path_returns_404(client, tmp_path):
    resp = client.post("/recording/import_file", json={
        "path": str(tmp_path / "no_such.json"),
        "format": "json",
    })
    assert resp.status_code == 404


def test_import_file_unknown_format_returns_400(client, tmp_path):
    src = tmp_path / "rec.json"
    _write_json_recording(str(src), n=2)
    resp = client.post("/recording/import_file", json={
        "path": str(src),
        "format": "csv",
    })
    assert resp.status_code == 400


def test_import_file_missing_samples_returns_400(client, tmp_path):
    src = tmp_path / "bad.json"
    with open(src, "w") as f:
        json.dump({"meta": {}}, f)
    resp = client.post("/recording/import_file", json={
        "path": str(src),
        "format": "json",
    })
    assert resp.status_code == 400
    assert "samples" in resp.json()["detail"].lower()


def test_import_file_malformed_T_returns_400(client, tmp_path):
    src = tmp_path / "bad.json"
    with open(src, "w") as f:
        json.dump({"samples": [{"ts": 1.0, "T": [[1, 2, 3], [4, 5, 6]]}]}, f)
    resp = client.post("/recording/import_file", json={
        "path": str(src),
        "format": "json",
    })
    assert resp.status_code == 400
    assert "4x4" in resp.json()["detail"]
