# Vive ↔ UMI link calibration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a record-import-sync-calibrate pipeline to LinkCalibTab so the user can recover `T_vive_umi` (rigid mounting between a SteamVR Vive tracker and a UMI headset's eef VIO) from a live Vive recording + an imported UMI MCAP file.

**Architecture:** Add `wall_ts` to the existing `/poses/stream` so Vive samples carry epoch timestamps. Add five backend endpoints: `/recording/save`, `/recording/list_topics`, `/recording/import_mcap`, `/recording/sync`, `/calibrate/handeye_pose`. Two new backend modules: `app/calib/sync.py` (cross-correlate speed signals → constant-offset alignment → nearest-neighbor pairing) and `app/calib/handeye_pose.py` (thin `cv2.calibrateHandEye` wrapper for the no-image case). Renderer adds an "Inputs mode" Seg in LinkCalibTab; the new `vive + mcap` mode shows record / import / sync / solve sections with gating between steps.

**Tech Stack:** FastAPI + OpenCV + NumPy (backend), `mcap` 1.3.1 already in venv, adding `mcap-protobuf` and `foxglove-schemas-protobuf` to dev extras. React 18 (renderer). pytest for backend.

**Spec:** `docs/superpowers/specs/2026-04-28-link-vive-umi-design.md`

---

## File Structure

| File | Role |
| --- | --- |
| `backend/app/api/routes.py` | Add `wall_ts` to pose stream + 5 new endpoints |
| `backend/app/calib/sync.py` (new) | Speed-signal cross-correlation + nearest-neighbor pairing |
| `backend/app/calib/handeye_pose.py` (new) | cv2.calibrateHandEye wrapper for synced pose pairs |
| `backend/app/models.py` | Pydantic models for the new endpoints |
| `backend/pyproject.toml` | `mcap-protobuf`, `foxglove-schemas-protobuf` in dev extras |
| `backend/tests/test_sync.py` (new) | Sync algorithm unit tests |
| `backend/tests/test_handeye_pose.py` (new) | Solver round-trip tests |
| `backend/tests/test_import_mcap.py` (new) | MCAP importer fixture-based tests |
| `renderer/src/api/client.js` | 5 new client functions |
| `renderer/src/tabs/LinkCalibTab.jsx` | Inputs mode Seg + 4 new sections (record / import / sync / solve) |

---

### Task 1: Backend — add `wall_ts` to `/poses/stream` sample messages

The renderer needs an epoch timestamp on every Vive pose tick to record alongside the pose; the existing `"ts"` is monotonic since stream start, so it can't sync with UMI's wall-clock timestamps. Add `time.time()` to each sample message; existing consumers ignore the new field.

**Files:**
- Modify: `backend/app/api/routes.py:546-560` (the sample-loop in `poses_stream`)

- [ ] **Step 1: Update the sample message**

In `backend/app/api/routes.py`, locate the `while True:` loop inside `poses_stream` (around line 546-560). Replace the `msg = {...}` line so it includes `"wall_ts": time.time()`:

```python
        period = 1.0 / max(1, fps)
        seq = 0
        t0 = time.monotonic()
        while True:
            t = time.monotonic() - t0
            merged: dict = {}
            for _name, src in built:
                merged.update(src.poll(t))
            msg = {
                "type": "sample",
                "seq": seq,
                "ts": t,
                "wall_ts": time.time(),
                "poses": merged,
            }
            try:
                await ws.send_text(json.dumps(msg))
            except (WebSocketDisconnect, RuntimeError):
                break
            seq += 1
            await asyncio.sleep(period)
```

- [ ] **Step 2: Smoke-check with the running backend**

Start uvicorn in the background (`run_in_background=true`):

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m uvicorn app.main:app --port 8765
```

Confirm a sample message includes `wall_ts`:

```bash
PYTHONPATH="" /home/mi/Calibration/backend/.venv/bin/python -c "
import asyncio, json, websockets
async def go():
    async with websockets.connect('ws://127.0.0.1:8765/poses/stream?sources=mock&fps=5') as ws:
        await ws.recv()  # hello
        sample = json.loads(await ws.recv())
        assert sample['type'] == 'sample'
        assert isinstance(sample.get('wall_ts'), float)
        assert sample['wall_ts'] > 1.7e9, sample['wall_ts']
        print('ok wall_ts =', sample['wall_ts'])
asyncio.run(go())
"
```

Expected: prints `ok wall_ts = 1.77...e9`. Stop the backend.

- [ ] **Step 3: Run existing tests**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/ -v
```

Expected: 11 PASSED (no new tests yet; existing suite unchanged).

- [ ] **Step 4: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/api/routes.py && git commit -m "feat(api): add wall_ts to /poses/stream sample messages"
```

---

### Task 2: Backend dependencies — add MCAP/protobuf libs

Two libraries: `mcap-protobuf` (decoder built on top of `mcap` 1.3.1) and `foxglove-schemas-protobuf` (Python proto classes for `PoseInFrame`, used by both the importer and the test fixtures).

**Files:**
- Modify: `backend/pyproject.toml`

- [ ] **Step 1: Add the deps**

In `backend/pyproject.toml`, locate the `dev` line (currently `dev = ["pyinstaller>=6.11", "pytest>=8.3", "httpx>=0.27"]`) and replace with:

```toml
dev = [
  "pyinstaller>=6.11",
  "pytest>=8.3",
  "httpx>=0.27",
  "mcap-protobuf>=0.4",
  "foxglove-schemas-protobuf>=0.3",
]
```

- [ ] **Step 2: Install into the venv**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/pip install -e ".[dev]"
```

Expected: pip installs `mcap-protobuf`, `foxglove-schemas-protobuf`, and any transitive deps (`protobuf`, etc.). No errors.

- [ ] **Step 3: Verify the imports work**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -c "
from mcap_protobuf.reader import read_protobuf_messages
from mcap_protobuf.writer import Writer
from foxglove_schemas_protobuf.PoseInFrame_pb2 import PoseInFrame
print('ok')
"
```

Expected: prints `ok`.

- [ ] **Step 4: Run existing tests**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/ -v
```

Expected: still 11 PASSED.

- [ ] **Step 5: Commit**

```bash
cd /home/mi/Calibration && git add backend/pyproject.toml && git commit -m "chore(deps): add mcap-protobuf + foxglove-schemas-protobuf for vive-umi link calib"
```

---

### Task 3: Backend — `/recording/save` and `/recording/list_topics` endpoints

`/recording/save` writes a canonical pose-list JSON (used for both Vive recordings — produced renderer-side — and UMI imports — produced backend-side). `/recording/list_topics` peeks at an MCAP file and returns the topics whose schema is `foxglove.PoseInFrame`, so the renderer's Import dialog can show a topic dropdown.

**Files:**
- Modify: `backend/app/api/routes.py` (append new endpoints near the end)

- [ ] **Step 1: Add the `/recording/save` endpoint**

Append to `backend/app/api/routes.py` (after the existing `/calibration/load` handler, before the WebSocket section):

```python
@router.post("/recording/save")
async def recording_save(body: dict) -> dict:
    """Write a canonical pose-list JSON to disk.

    Body shape:
      { "kind": "vive" | "umi", "samples": [{"ts": <epoch_s>, "T": [[4x4]]}, ...], "path": <abs path> }

    Output JSON shape:
      { "meta": {"kind", "n", "t_first", "t_last"}, "samples": [...] }
    """
    kind = body.get("kind")
    samples = body.get("samples")
    path = body.get("path")
    if kind not in ("vive", "umi"):
        raise HTTPException(status_code=400, detail=f"unknown kind: {kind}")
    if not isinstance(samples, list) or not samples:
        raise HTTPException(status_code=400, detail="samples must be a non-empty list")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    # Validate sample shapes lightly — let JSON serialisation catch deep issues.
    for i, s in enumerate(samples[:5]):
        if not isinstance(s, dict) or "ts" not in s or "T" not in s:
            raise HTTPException(status_code=400, detail=f"sample[{i}] must have ts and T")
    try:
        ts_list = [float(s["ts"]) for s in samples]
        out = {
            "meta": {
                "kind": kind,
                "n": len(samples),
                "t_first": ts_list[0],
                "t_last": ts_list[-1],
            },
            "samples": samples,
        }
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            json.dump(out, f)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}")
    return {"ok": True, "path": path, "n": len(samples)}
```

- [ ] **Step 2: Add the `/recording/list_topics` endpoint**

Append immediately after step 1's endpoint:

```python
@router.get("/recording/list_topics")
async def recording_list_topics(mcap_path: str) -> dict:
    """Peek at the MCAP file and return topics whose schema is foxglove.PoseInFrame.
    Used by the renderer's import dialog to show a topic dropdown."""
    if not mcap_path or not os.path.isfile(mcap_path):
        raise HTTPException(status_code=404, detail="mcap not found")
    from mcap.reader import make_reader
    try:
        with open(mcap_path, "rb") as f:
            reader = make_reader(f)
            summary = reader.get_summary()
            schemas = summary.schemas
            channels = summary.channels
            stats = summary.statistics.channel_message_counts
            pose_schema_ids = {
                s.id for s in schemas.values()
                if s.name == "foxglove.PoseInFrame"
            }
            topics = [
                {
                    "topic": ch.topic,
                    "n": int(stats.get(ch.id, 0)),
                    "schema": schemas[ch.schema_id].name if ch.schema_id in schemas else None,
                }
                for ch in channels.values()
                if ch.schema_id in pose_schema_ids
            ]
            topics.sort(key=lambda t: -t["n"])
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"mcap read failed: {e}")
    return {"topics": topics}
```

- [ ] **Step 3: Smoke-test `/recording/save`**

Start uvicorn in the background:

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m uvicorn app.main:app --port 8765
```

In another shell:

```bash
TMP=$(mktemp -d)
curl -s -X POST http://127.0.0.1:8765/recording/save -H 'Content-Type: application/json' -d '{
  "kind": "vive",
  "path": "'"$TMP"'/vive.json",
  "samples": [
    {"ts": 1775381900.0, "T": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]},
    {"ts": 1775381900.5, "T": [[1,0,0,0.1],[0,1,0,0],[0,0,1,0],[0,0,0,1]]}
  ]
}'
echo
cat "$TMP/vive.json" | python3 -m json.tool
```

Expected: response `{"ok":true,"path":...,"n":2}`; cat output shows the canonical schema with `meta.n=2`. Bogus kind:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8765/recording/save -H 'Content-Type: application/json' -d '{"kind":"bogus","path":"/tmp/x","samples":[{"ts":0,"T":[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]}]}'
```

Expected: `400`.

- [ ] **Step 4: Smoke-test `/recording/list_topics`** — only if you have access to the user's MCAP file at `/home/mi/Downloads/DAS-EGO-rk3588-1307e1dc38ec99a0-edge_events-DAS-Ego_20260405173815_center_leader_f3d0899d_ec99a0_process_merge_vio_first_third_infer_result.mcap`. Otherwise skip.

```bash
curl -s "http://127.0.0.1:8765/recording/list_topics?mcap_path=/home/mi/Downloads/DAS-EGO-rk3588-1307e1dc38ec99a0-edge_events-DAS-Ego_20260405173815_center_leader_f3d0899d_ec99a0_process_merge_vio_first_third_infer_result.mcap" | python3 -m json.tool
```

Expected: JSON listing topics, with `/robot0/vio/eef_pose`, `/robot1/vio/eef_pose`, `/robot2/vio/eef_pose`, `/robot0/vio/relative_eef_pose`, etc., each with non-zero `n`.

Stop the backend.

- [ ] **Step 5: Run existing tests**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/ -v
```

Expected: 11 PASSED.

- [ ] **Step 6: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/api/routes.py && git commit -m "feat(api): /recording/save + /recording/list_topics endpoints"
```

---

### Task 4: Backend — `/recording/import_mcap` endpoint + tests

Reads an MCAP file, extracts `foxglove.PoseInFrame` messages on a topic, builds 4×4 transforms, drops degenerate-quaternion samples, writes the canonical JSON via the same on-disk schema as Task 3.

**Files:**
- Modify: `backend/app/api/routes.py` (append endpoint)
- Create: `backend/tests/test_import_mcap.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_import_mcap.py`:

```python
"""Tests for the /recording/import_mcap endpoint."""
from __future__ import annotations

import json
import os

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _build_fixture_mcap(path: str, n: int = 5):
    """Build a tiny MCAP with N foxglove.PoseInFrame messages on /robot0/vio/eef_pose,
    timestamps starting at epoch ts0 spaced 0.1s apart, identity rotation, position x=i."""
    from mcap_protobuf.writer import Writer
    from foxglove_schemas_protobuf.PoseInFrame_pb2 import PoseInFrame

    ts0 = 1_775_381_900_000_000_000  # ns
    with open(path, "wb") as f, Writer(f) as writer:
        for i in range(n):
            ts_ns = ts0 + i * 100_000_000
            msg = PoseInFrame()
            msg.timestamp.seconds = ts_ns // 1_000_000_000
            msg.timestamp.nanos = ts_ns % 1_000_000_000
            msg.frame_id = "world"
            msg.pose.position.x = float(i)
            msg.pose.position.y = 0.0
            msg.pose.position.z = 0.0
            msg.pose.orientation.x = 0.0
            msg.pose.orientation.y = 0.0
            msg.pose.orientation.z = 0.0
            msg.pose.orientation.w = 1.0
            writer.write_message(
                topic="/robot0/vio/eef_pose",
                message=msg,
                log_time=ts_ns,
                publish_time=ts_ns,
            )


def test_import_mcap_extracts_pose_in_frame(client, tmp_path):
    mcap_path = tmp_path / "tiny.mcap"
    out_path = tmp_path / "umi.json"
    _build_fixture_mcap(str(mcap_path), n=5)

    resp = client.post("/recording/import_mcap", json={
        "mcap_path": str(mcap_path),
        "topic": "/robot0/vio/eef_pose",
        "out_path": str(out_path),
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["count"] == 5
    # t_first should be the epoch seconds of the first message.
    assert abs(body["t_first"] - 1_775_381_900.0) < 1e-3

    # Verify the output JSON.
    with open(out_path) as f:
        data = json.load(f)
    assert data["meta"]["kind"] == "umi"
    assert data["meta"]["n"] == 5
    assert len(data["samples"]) == 5
    # First sample: identity rotation, position (0, 0, 0).
    T0 = np.array(data["samples"][0]["T"], dtype=float)
    assert T0.shape == (4, 4)
    assert np.allclose(T0[:3, :3], np.eye(3))
    assert np.allclose(T0[:3, 3], [0, 0, 0])
    # Third sample: position x=2.
    T2 = np.array(data["samples"][2]["T"], dtype=float)
    assert np.allclose(T2[:3, 3], [2, 0, 0])


def test_import_mcap_unknown_topic_returns_400(client, tmp_path):
    mcap_path = tmp_path / "tiny.mcap"
    out_path = tmp_path / "umi.json"
    _build_fixture_mcap(str(mcap_path), n=2)

    resp = client.post("/recording/import_mcap", json={
        "mcap_path": str(mcap_path),
        "topic": "/does/not/exist",
        "out_path": str(out_path),
    })
    assert resp.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_import_mcap.py -v
```

Expected: both tests FAIL (404 from missing endpoint).

- [ ] **Step 3: Implement the endpoint**

Append to `backend/app/api/routes.py` (after the `/recording/list_topics` handler):

```python
@router.post("/recording/import_mcap")
async def recording_import_mcap(body: dict) -> dict:
    """Read an MCAP file and extract foxglove.PoseInFrame messages on the given topic.

    Body: { mcap_path, topic, out_path }
    Writes a canonical pose-list JSON to out_path.
    Returns { ok, count, t_first, t_last, path }.
    """
    mcap_path = body.get("mcap_path")
    topic = body.get("topic")
    out_path = body.get("out_path")
    if not mcap_path or not os.path.isfile(mcap_path):
        raise HTTPException(status_code=404, detail="mcap not found")
    if not topic:
        raise HTTPException(status_code=400, detail="topic is required")
    if not out_path:
        raise HTTPException(status_code=400, detail="out_path is required")

    from mcap_protobuf.reader import read_protobuf_messages

    samples = []
    n_drop_quat = 0
    n_seen = 0
    try:
        for msg_tuple in read_protobuf_messages(mcap_path, topics=[topic]):
            n_seen += 1
            pb = msg_tuple.proto_msg
            ts = pb.timestamp.seconds + pb.timestamp.nanos / 1e9
            qx = pb.pose.orientation.x
            qy = pb.pose.orientation.y
            qz = pb.pose.orientation.z
            qw = pb.pose.orientation.w
            qnorm = (qx * qx + qy * qy + qz * qz + qw * qw) ** 0.5
            if qnorm < 0.5:
                n_drop_quat += 1
                continue
            qx, qy, qz, qw = qx / qnorm, qy / qnorm, qz / qnorm, qw / qnorm
            R = np.array([
                [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
                [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
                [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
            ], dtype=np.float64)
            T = np.eye(4)
            T[:3, :3] = R
            T[:3, 3] = [pb.pose.position.x, pb.pose.position.y, pb.pose.position.z]
            samples.append({"ts": ts, "T": T.tolist()})
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"mcap read failed: {e}")

    if n_seen == 0:
        raise HTTPException(status_code=400, detail=f"no messages found on topic {topic!r}")

    if not samples:
        raise HTTPException(status_code=400, detail=f"all {n_seen} messages had degenerate quaternions")

    out = {
        "meta": {
            "kind": "umi",
            "n": len(samples),
            "t_first": samples[0]["ts"],
            "t_last": samples[-1]["ts"],
            "topic": topic,
            "n_dropped_quat": n_drop_quat,
        },
        "samples": samples,
    }
    try:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(out, f)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}")

    return {
        "ok": True,
        "count": len(samples),
        "t_first": out["meta"]["t_first"],
        "t_last": out["meta"]["t_last"],
        "path": out_path,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_import_mcap.py -v
```

Expected: both tests PASS.

- [ ] **Step 5: Run full suite**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/ -v
```

Expected: 13 PASSED (11 existing + 2 new).

- [ ] **Step 6: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/api/routes.py backend/tests/test_import_mcap.py && git commit -m "feat(api): /recording/import_mcap extracts foxglove PoseInFrame to canonical JSON"
```

---

### Task 5: Backend — sync module + `/recording/sync` endpoint + tests

Cross-correlates speed signals to estimate `delta_t`, then walks the merged timeline pairing Vive samples to UMI samples (nearest-neighbor within `max_pair_gap_s`). Reports per-stream rotation diversity so the UI can warn when the user didn't move enough.

**Files:**
- Create: `backend/app/calib/sync.py`
- Modify: `backend/app/api/routes.py` (append endpoint)
- Create: `backend/tests/test_sync.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_sync.py`:

```python
"""Tests for the sync helper in app.calib.sync."""
from __future__ import annotations

import math

import numpy as np
import pytest

from app.calib.sync import sync_streams


def _make_stream(t_start: float, n: int, dt: float = 1.0 / 30.0, motion: str = "circle"):
    """Build a synthetic stream of {ts, T} for the time range [t_start, t_start + n*dt).
    Default motion: a circle in xy with constant 1 rad/s yaw (lots of rotation diversity)."""
    samples = []
    for i in range(n):
        t = t_start + i * dt
        ang = i * dt * 1.0  # rad
        c, s = math.cos(ang), math.sin(ang)
        T = np.eye(4)
        if motion == "circle":
            T[:3, :3] = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)
            T[:3, 3] = [c, s, 0.5 * math.sin(2 * ang)]
        elif motion == "static":
            pass
        samples.append({"ts": t, "T": T.tolist()})
    return samples


def test_sync_recovers_known_offset():
    """Two streams of the same trajectory; UMI's clock is 0.3 s ahead of Vive's.
    Sync should recover delta_t ≈ -0.3 (subtract from umi.ts to align with vive.ts)."""
    vive = _make_stream(t_start=1000.0, n=300, dt=1 / 30)
    umi = _make_stream(t_start=1000.3, n=300, dt=1 / 30)
    res = sync_streams(vive, umi, max_skew_s=2.0, max_pair_gap_s=0.05)
    assert res["ok"] is True
    assert abs(res["delta_t"] + 0.3) < 0.04, f"delta_t={res['delta_t']}"
    assert res["n_pairs"] >= 200


def test_sync_zero_offset():
    """Same start time → delta_t≈0."""
    vive = _make_stream(t_start=2000.0, n=300, dt=1 / 30)
    umi = _make_stream(t_start=2000.0, n=300, dt=1 / 30)
    res = sync_streams(vive, umi, max_skew_s=2.0, max_pair_gap_s=0.05)
    assert res["ok"] is True
    assert abs(res["delta_t"]) < 0.02


def test_sync_static_stream_fails_diversity():
    """Static streams have no motion to lock onto + zero rotation diversity."""
    vive = _make_stream(t_start=3000.0, n=200, dt=1 / 30, motion="static")
    umi = _make_stream(t_start=3000.0, n=200, dt=1 / 30, motion="static")
    res = sync_streams(vive, umi, max_skew_s=2.0, max_pair_gap_s=0.05)
    # Either the SNR check fails (no peak in cross-correlation) or rotation
    # diversity is reported as 0. Both are acceptable outcomes — the caller
    # gates on these fields, not on ok=False.
    assert res["vive_rot_deg"] < 1.0
    assert res["umi_rot_deg"] < 1.0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_sync.py -v
```

Expected: all three FAIL — `ImportError: cannot import name 'sync_streams' from 'app.calib.sync'`.

- [ ] **Step 3: Implement `app/calib/sync.py`**

Create `backend/app/calib/sync.py`:

```python
"""Sync two pose streams by cross-correlating their speed signals.

Both streams are lists of {"ts": <epoch_s>, "T": [[4x4]]} dicts.
1. Resample positions to a common 50 Hz grid (linear interp).
2. Compute |dx/dt| per stream.
3. Cross-correlate over [-max_skew_s, +max_skew_s], peak position = delta_t.
4. With offset applied, walk the merged timeline; nearest-neighbor pair within max_pair_gap_s.
5. Report rotation diversity so the caller can gate.
"""
from __future__ import annotations

import logging
import math

import numpy as np

log = logging.getLogger("calib.sync")

_RESAMPLE_HZ = 50.0


def _samples_to_arrays(samples: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ts = np.asarray([s["ts"] for s in samples], dtype=np.float64)
    Ts = np.asarray([s["T"] for s in samples], dtype=np.float64)
    pos = Ts[:, :3, 3]
    R = Ts[:, :3, :3]
    return ts, pos, R


def _resample_positions(ts: np.ndarray, pos: np.ndarray, t_grid: np.ndarray) -> np.ndarray:
    """Linear interpolation of each axis to t_grid; samples outside [ts[0], ts[-1]] held to the edge."""
    out = np.empty((t_grid.size, 3), dtype=np.float64)
    for axis in range(3):
        out[:, axis] = np.interp(t_grid, ts, pos[:, axis])
    return out


def _speed_signal(ts: np.ndarray, pos: np.ndarray, t_grid: np.ndarray) -> np.ndarray:
    p = _resample_positions(ts, pos, t_grid)
    v = np.linalg.norm(np.diff(p, axis=0), axis=1) * _RESAMPLE_HZ  # m/s
    return v


def _rotation_diversity_deg(R: np.ndarray) -> float:
    """Max angle between any sample's rotation and the first sample's rotation, in degrees."""
    if R.shape[0] < 2:
        return 0.0
    R0_inv = R[0].T
    max_ang = 0.0
    for i in range(1, R.shape[0]):
        delta = R0_inv @ R[i]
        # Angle of rotation from trace.
        cos_ang = (np.trace(delta) - 1.0) / 2.0
        cos_ang = float(np.clip(cos_ang, -1.0, 1.0))
        ang = math.degrees(math.acos(cos_ang))
        if ang > max_ang:
            max_ang = ang
    return max_ang


def _xcorr_peak(a: np.ndarray, b: np.ndarray, max_lag: int) -> tuple[int, float]:
    """Cross-correlate a vs b for lags in [-max_lag, +max_lag]. Returns (lag, peak/mean ratio).

    Positive lag means a is delayed relative to b by `lag` samples; equivalently,
    add (lag / _RESAMPLE_HZ) seconds to b's clock to align with a.
    """
    a = a - a.mean()
    b = b - b.mean()
    n = min(a.size, b.size)
    a = a[:n]
    b = b[:n]
    lags = np.arange(-max_lag, max_lag + 1)
    cc = np.empty(lags.size, dtype=np.float64)
    for k, lag in enumerate(lags):
        if lag >= 0:
            cc[k] = float(np.dot(a[lag:], b[: n - lag]))
        else:
            cc[k] = float(np.dot(a[: n + lag], b[-lag:]))
    cc_abs = np.abs(cc)
    peak_idx = int(np.argmax(cc_abs))
    peak = cc_abs[peak_idx]
    mean = float(cc_abs.mean()) or 1e-9
    return int(lags[peak_idx]), peak / mean


def sync_streams(
    vive: list[dict],
    umi: list[dict],
    max_skew_s: float = 5.0,
    max_pair_gap_s: float = 0.05,
) -> dict:
    """See module docstring."""
    if len(vive) < 10 or len(umi) < 10:
        return {
            "ok": False,
            "reason": f"streams too short (vive={len(vive)} umi={len(umi)})",
            "delta_t": 0.0, "n_pairs": 0,
            "vive_rot_deg": 0.0, "umi_rot_deg": 0.0,
            "pairs": [],
        }

    ts_v, pos_v, R_v = _samples_to_arrays(vive)
    ts_u, pos_u, R_u = _samples_to_arrays(umi)

    # Common time grid covering the overlap region (post-offset, we may shift).
    t_lo = max(ts_v[0], ts_u[0]) - max_skew_s
    t_hi = min(ts_v[-1], ts_u[-1]) + max_skew_s
    if t_hi - t_lo < 1.0:
        return {
            "ok": False,
            "reason": f"streams don't overlap within {max_skew_s}s",
            "delta_t": 0.0, "n_pairs": 0,
            "vive_rot_deg": 0.0, "umi_rot_deg": 0.0,
            "pairs": [],
        }
    t_grid = np.arange(t_lo, t_hi, 1.0 / _RESAMPLE_HZ)

    sv = _speed_signal(ts_v, pos_v, t_grid)
    su = _speed_signal(ts_u, pos_u, t_grid)

    max_lag = int(max_skew_s * _RESAMPLE_HZ)
    lag, snr = _xcorr_peak(sv, su, max_lag)
    delta_t = lag / _RESAMPLE_HZ  # add this to umi.ts to align with vive.ts

    if snr < 3.0:
        return {
            "ok": False,
            "reason": f"low cross-correlation SNR ({snr:.2f}); user probably didn't move enough",
            "delta_t": float(delta_t), "n_pairs": 0,
            "vive_rot_deg": float(_rotation_diversity_deg(R_v)),
            "umi_rot_deg": float(_rotation_diversity_deg(R_u)),
            "pairs": [],
        }

    # Pair each Vive sample with the nearest UMI sample (after offset).
    ts_u_aligned = ts_u + delta_t
    j = 0
    pairs = []
    for i, tv in enumerate(ts_v):
        # Advance j until ts_u_aligned[j] is the closest to tv.
        while j + 1 < len(ts_u_aligned) and abs(ts_u_aligned[j + 1] - tv) < abs(ts_u_aligned[j] - tv):
            j += 1
        gap = abs(ts_u_aligned[j] - tv)
        if gap <= max_pair_gap_s:
            pairs.append({
                "ts": float(tv),
                "T_vive": vive[i]["T"],
                "T_umi": umi[j]["T"],
            })

    return {
        "ok": True,
        "delta_t": float(delta_t),
        "snr": float(snr),
        "n_pairs": len(pairs),
        "vive_rot_deg": float(_rotation_diversity_deg(R_v)),
        "umi_rot_deg": float(_rotation_diversity_deg(R_u)),
        "pairs": pairs,
    }
```

- [ ] **Step 4: Run sync tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_sync.py -v
```

Expected: all three PASS.

- [ ] **Step 5: Add the `/recording/sync` endpoint**

Append to `backend/app/api/routes.py`:

```python
@router.post("/recording/sync")
async def recording_sync(body: dict) -> dict:
    """Sync a Vive recording + UMI import into a paired-sample JSON.

    Body: { vive_path, umi_path, out_path, max_skew_s = 5.0, max_pair_gap_s = 0.05 }
    Writes synced JSON to out_path. Returns sync diagnostics.
    """
    from app.calib.sync import sync_streams

    vive_path = body.get("vive_path")
    umi_path = body.get("umi_path")
    out_path = body.get("out_path")
    if not (vive_path and os.path.isfile(vive_path)):
        raise HTTPException(status_code=404, detail="vive_path not found")
    if not (umi_path and os.path.isfile(umi_path)):
        raise HTTPException(status_code=404, detail="umi_path not found")
    if not out_path:
        raise HTTPException(status_code=400, detail="out_path required")

    max_skew_s = float(body.get("max_skew_s", 5.0))
    max_pair_gap_s = float(body.get("max_pair_gap_s", 0.05))

    with open(vive_path) as f:
        vive_data = json.load(f)
    with open(umi_path) as f:
        umi_data = json.load(f)

    res = sync_streams(
        vive_data["samples"], umi_data["samples"],
        max_skew_s=max_skew_s, max_pair_gap_s=max_pair_gap_s,
    )
    if not res["ok"]:
        raise HTTPException(status_code=400, detail=res.get("reason") or "sync failed")
    if res["n_pairs"] < 50:
        raise HTTPException(status_code=400, detail=f"only {res['n_pairs']} pairs after sync (need ≥ 50)")

    out = {
        "meta": {
            "kind": "synced",
            "n": res["n_pairs"],
            "delta_t": res["delta_t"],
            "vive_rot_deg": res["vive_rot_deg"],
            "umi_rot_deg": res["umi_rot_deg"],
        },
        "samples": res["pairs"],
    }
    try:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(out, f)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}")

    return {
        "ok": True,
        "n_pairs": res["n_pairs"],
        "delta_t": res["delta_t"],
        "snr": res.get("snr"),
        "vive_rot_deg": res["vive_rot_deg"],
        "umi_rot_deg": res["umi_rot_deg"],
        "path": out_path,
    }
```

- [ ] **Step 6: Run full suite**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/ -v
```

Expected: 16 PASSED (13 + 3 new sync tests).

- [ ] **Step 7: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/calib/sync.py backend/app/api/routes.py backend/tests/test_sync.py && git commit -m "feat(sync): cross-correlated speed-signal sync + /recording/sync endpoint"
```

---

### Task 6: Backend — handeye_pose module + `/calibrate/handeye_pose` endpoint + tests

`cv2.calibrateHandEye` already solves AX = XB; we just need a thin wrapper that takes the synced pose pairs (no images, no `solvePnP`) and computes per-pair residuals.

**Files:**
- Create: `backend/app/calib/handeye_pose.py`
- Modify: `backend/app/api/routes.py` (append endpoint)
- Create: `backend/tests/test_handeye_pose.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_handeye_pose.py`:

```python
"""Tests for cv2.calibrateHandEye-based solver in app.calib.handeye_pose."""
from __future__ import annotations

import math

import numpy as np
import pytest

from app.calib.handeye_pose import solve_handeye_pose


def _rotmat(axis, ang):
    a = np.asarray(axis, float); a /= np.linalg.norm(a)
    c, s, v = math.cos(ang), math.sin(ang), 1 - math.cos(ang)
    x, y, z = a
    return np.array([
        [c + x * x * v, x * y * v - z * s, x * z * v + y * s],
        [y * x * v + z * s, c + y * y * v, y * z * v - x * s],
        [z * x * v - y * s, z * y * v + x * s, c + z * z * v],
    ])


def _T(R, t):
    out = np.eye(4); out[:3, :3] = R; out[:3, 3] = t; return out


def _build_synced_from_truth(X_true: np.ndarray, n: int = 60, seed: int = 7) -> list[dict]:
    """Generate `n` synced pose pairs (T_vive, T_umi) under T_umi = W · T_vive · X_true,
    with W and a randomly-tumbling rig pose. The world-frame mismatch W is also random
    but constant across samples — the solver should still recover X_true."""
    rng = np.random.default_rng(seed)
    W = _T(_rotmat([0.3, -0.5, 0.8], 0.7), [0.4, -0.2, 0.1])
    pairs = []
    for i in range(n):
        # Random rig pose in vive world.
        ax = rng.normal(size=3)
        ang = rng.uniform(-2.5, 2.5)
        t = rng.uniform(-1.0, 1.0, size=3)
        T_vive = _T(_rotmat(ax, ang), t)
        T_umi = W @ T_vive @ X_true
        pairs.append({"ts": float(i), "T_vive": T_vive.tolist(), "T_umi": T_umi.tolist()})
    return pairs


def test_solve_handeye_pose_recovers_truth():
    X_true = _T(_rotmat([1.0, 0.5, -0.3], 0.4), [0.07, -0.03, 0.12])
    pairs = _build_synced_from_truth(X_true, n=60)
    res = solve_handeye_pose(pairs, method="daniilidis")
    assert res.ok is True
    X = np.array(res.T)
    R_err = X[:3, :3].T @ X_true[:3, :3]
    cos_ang = (np.trace(R_err) - 1) / 2
    cos_ang = float(np.clip(cos_ang, -1, 1))
    ang_deg = math.degrees(math.acos(cos_ang))
    t_err_mm = 1000.0 * np.linalg.norm(X[:3, 3] - X_true[:3, 3])
    assert ang_deg < 0.5, f"rotation error {ang_deg:.3f}° too large"
    assert t_err_mm < 1.0, f"translation error {t_err_mm:.3f} mm too large"


def test_solve_handeye_pose_too_few_pairs():
    pairs = _build_synced_from_truth(np.eye(4), n=2)
    res = solve_handeye_pose(pairs, method="daniilidis")
    assert res.ok is False
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_handeye_pose.py -v
```

Expected: both FAIL (`ModuleNotFoundError: No module named 'app.calib.handeye_pose'`).

- [ ] **Step 3: Implement `app/calib/handeye_pose.py`**

Create `backend/app/calib/handeye_pose.py`:

```python
"""Hand-Eye AX=XB solver for pre-paired pose streams (no images, no solvePnP).

Used by the LinkCalibTab vive+mcap flow: given synced (T_vive, T_umi) pairs,
recover the rigid mounting X = T_vive_umi via cv2.calibrateHandEye. The two
tracking systems may live in different world frames (a constant W); the
solver internally takes pairwise pose deltas, which cancels W.
"""
from __future__ import annotations

import logging
import math

import cv2
import numpy as np

from app.models import CalibrationResult

log = logging.getLogger("calib.handeye_pose")

_METHOD_FLAGS = {
    "tsai":       cv2.CALIB_HAND_EYE_TSAI,
    "park":       cv2.CALIB_HAND_EYE_PARK,
    "horaud":     cv2.CALIB_HAND_EYE_HORAUD,
    "andreff":    cv2.CALIB_HAND_EYE_ANDREFF,
    "daniilidis": cv2.CALIB_HAND_EYE_DANIILIDIS,
}


def _split(Ts: list[np.ndarray]) -> tuple[list[np.ndarray], list[np.ndarray]]:
    R = [T[:3, :3] for T in Ts]
    t = [T[:3, 3].reshape(3, 1) for T in Ts]
    return R, t


def _per_pair_residuals(
    T_vive_list: list[np.ndarray], T_umi_list: list[np.ndarray], X: np.ndarray,
) -> tuple[list[float], list[float]]:
    """Estimate W = T_umi · X^-1 · T_vive^-1 from each pair, take its median over rotations
    and translations, then report each pair's deviation from the median W."""
    Xinv = np.linalg.inv(X)
    Ws = [T_u @ Xinv @ np.linalg.inv(T_v) for T_v, T_u in zip(T_vive_list, T_umi_list)]
    Rs = np.array([W[:3, :3] for W in Ws])
    ts = np.array([W[:3, 3] for W in Ws])
    R_med = Rs.mean(axis=0)
    # Project onto SO(3).
    U, _, Vt = np.linalg.svd(R_med)
    R_ref = U @ np.diag([1, 1, np.linalg.det(U @ Vt)]) @ Vt
    t_ref = ts.mean(axis=0)
    angs = []
    pos_mm = []
    for W in Ws:
        dR = W[:3, :3].T @ R_ref
        cos_ang = (np.trace(dR) - 1.0) / 2.0
        ang = math.degrees(math.acos(float(np.clip(cos_ang, -1, 1))))
        dt_mm = 1000.0 * float(np.linalg.norm(W[:3, 3] - t_ref))
        angs.append(ang)
        pos_mm.append(dt_mm)
    return angs, pos_mm


def solve_handeye_pose(pairs: list[dict], method: str = "daniilidis") -> CalibrationResult:
    """Pairs: list of {"ts", "T_vive": [[4x4]], "T_umi": [[4x4]]}.

    Returns CalibrationResult with T = T_vive_umi (4x4 nested list), rms = mean residual
    angle in degrees, per_frame_err = per-pair angle in degrees.
    """
    flag = _METHOD_FLAGS.get(method, cv2.CALIB_HAND_EYE_DANIILIDIS)
    if len(pairs) < 5:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"need ≥ 5 pairs, got {len(pairs)}",
        )
    T_vive = [np.asarray(p["T_vive"], dtype=np.float64) for p in pairs]
    T_umi = [np.asarray(p["T_umi"], dtype=np.float64) for p in pairs]
    R_v, t_v = _split(T_vive)
    R_u, t_u = _split(T_umi)
    try:
        R_X, t_X = cv2.calibrateHandEye(R_u, t_u, R_v, t_v, method=flag)
    except cv2.error as e:
        return CalibrationResult(ok=False, rms=0.0, message=f"cv2.calibrateHandEye failed: {e}")
    X = np.eye(4)
    X[:3, :3] = R_X
    X[:3, 3] = t_X.ravel()

    angs, pos_mm = _per_pair_residuals(T_vive, T_umi, X)
    rms_deg = float(np.sqrt(np.mean(np.square(angs))))
    log.info(
        "handeye_pose: %d pairs · rms %.3f° · pos rms %.2f mm (%s)",
        len(pairs), rms_deg, float(np.sqrt(np.mean(np.square(pos_mm)))), method,
    )
    return CalibrationResult(
        ok=True,
        rms=rms_deg,
        T=X.tolist(),
        per_frame_err=angs,
        iterations=0,
        final_cost=rms_deg ** 2 * len(pairs),
        message=f"{method}: {len(pairs)} pairs · pos rms {float(np.sqrt(np.mean(np.square(pos_mm)))):.2f} mm",
    )
```

- [ ] **Step 4: Run handeye_pose tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_handeye_pose.py -v
```

Expected: both PASS.

- [ ] **Step 5: Add the `/calibrate/handeye_pose` endpoint**

Append to `backend/app/api/routes.py`:

```python
@router.post("/calibrate/handeye_pose")
async def calibrate_handeye_pose(body: dict) -> CalibrationResult:
    """Solve T_vive_umi from a synced JSON file (Task 5 output).
    Body: { synced_path, method = "daniilidis" }.
    """
    from app.calib.handeye_pose import solve_handeye_pose

    synced_path = body.get("synced_path")
    method = (body.get("method") or "daniilidis").lower()
    if not (synced_path and os.path.isfile(synced_path)):
        raise HTTPException(status_code=404, detail="synced_path not found")
    if method not in ("tsai", "park", "horaud", "andreff", "daniilidis"):
        raise HTTPException(status_code=400, detail=f"unknown method: {method}")

    with open(synced_path) as f:
        data = json.load(f)
    pairs = data.get("samples") or []
    return solve_handeye_pose(pairs, method=method)
```

- [ ] **Step 6: Run full suite**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/ -v
```

Expected: 18 PASSED (16 + 2 new handeye_pose).

- [ ] **Step 7: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/calib/handeye_pose.py backend/app/api/routes.py backend/tests/test_handeye_pose.py && git commit -m "feat(handeye_pose): cv2.calibrateHandEye wrapper + /calibrate/handeye_pose endpoint"
```

---

### Task 7: Renderer — API client functions

Five thin functions that build the HTTP requests for the new endpoints. No UI yet.

**Files:**
- Modify: `renderer/src/api/client.js`

- [ ] **Step 1: Add the functions**

In `renderer/src/api/client.js`, after the existing exported `api` object's closing brace, add:

```js
export const recording = {
  save: ({ kind, samples, path }) =>
    request('/recording/save', { method: 'POST', body: JSON.stringify({ kind, samples, path }) }),
  listTopics: (mcap_path) =>
    request(`/recording/list_topics?mcap_path=${encodeURIComponent(mcap_path)}`),
  importMcap: ({ mcap_path, topic, out_path }) =>
    request('/recording/import_mcap', { method: 'POST', body: JSON.stringify({ mcap_path, topic, out_path }) }),
  sync: ({ vive_path, umi_path, out_path, max_skew_s, max_pair_gap_s }) =>
    request('/recording/sync', { method: 'POST', body: JSON.stringify({ vive_path, umi_path, out_path, max_skew_s, max_pair_gap_s }) }),
  calibrateHandeyePose: ({ synced_path, method }) =>
    request('/calibrate/handeye_pose', { method: 'POST', body: JSON.stringify({ synced_path, method }) }),
};
```

- [ ] **Step 2: Verify the renderer builds**

```bash
cd /home/mi/Calibration && npm run build:renderer
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/api/client.js && git commit -m "feat(api-client): recording.* functions for the vive+mcap link flow"
```

---

### Task 8: Renderer — LinkCalibTab inputs-mode Seg + Vive recording section

Adds a `live pair | vive + mcap` Seg at the top of the rail; the existing flow becomes the `live pair` mode, and the new `vive + mcap` mode shows the Vive recording section (rest of sections come in Tasks 9-10).

**Files:**
- Modify: `renderer/src/tabs/LinkCalibTab.jsx`

- [ ] **Step 1: Add state and the recording buffer ref**

In `renderer/src/tabs/LinkCalibTab.jsx`, near the existing `useState`s (after `gtLink`, around line 53), add:

```jsx
  // Inputs mode: 'live' (existing) or 'mcap' (new vive+mcap flow).
  const [inputsMode, setInputsMode] = useState('live');

  // Vive recording state (active only in mcap mode).
  const [recording, setRecording] = useState(false);
  const [viveRecCount, setViveRecCount] = useState(0);
  const [viveRecStart, setViveRecStart] = useState(null);
  const [vivePath, setVivePath] = useState('');
  const [umiPath, setUmiPath] = useState('');
  const [umiTopics, setUmiTopics] = useState([]);
  const [umiTopic, setUmiTopic] = useState('/robot0/vio/eef_pose');
  const [umiCount, setUmiCount] = useState(0);
  const [umiTimespan, setUmiTimespan] = useState(0);
  const [syncPath, setSyncPath] = useState('');
  const [syncDiag, setSyncDiag] = useState(null);     // { delta_t, n_pairs, vive_rot_deg, umi_rot_deg }
  const [solveMethod, setSolveMethod] = useState('daniilidis');
```

Also add a ref for the recording buffer (near other refs around line 56):

```jsx
  // Wall-clock timestamped pose buffer for the active recording session.
  const recordingRef = useRef([]);  // [{ ts: <epoch_s>, T: [[4x4]] }]
  const recordingActiveRef = useRef(false);
```

- [ ] **Step 2: Update the WS sample handler to push into `recordingRef`**

In the existing `ws.onmessage`, locate the `if (m.type !== 'sample') return;` block (around line 129). After the existing per-device drop-tracking loop and before the existing `if (!collectingRef.current) return;` gate (which is around line 141), add a recording push:

```jsx
        // Vive recording: capture wall-clock-stamped poses for the device the user picked.
        if (recordingActiveRef.current && m.wall_ts != null) {
          const T = samplePoses[devA];
          if (T) {
            recordingRef.current.push({ ts: m.wall_ts, T });
            // Throttle re-renders of the count display: bump every 10 samples.
            if (recordingRef.current.length % 10 === 0) {
              setViveRecCount(recordingRef.current.length);
            }
          }
        }
```

- [ ] **Step 3: Add the recording control handlers**

Below the existing `disconnect` callback (around line 162), add:

```jsx
  const startRecording = useCallback(() => {
    if (!connected) { setStatus('connect first'); return; }
    recordingRef.current = [];
    recordingActiveRef.current = true;
    setRecording(true);
    setViveRecCount(0);
    setViveRecStart(performance.now());
    setStatus('recording…');
  }, [connected]);

  const stopAndSaveRecording = useCallback(async () => {
    recordingActiveRef.current = false;
    setRecording(false);
    const samples = recordingRef.current.slice();
    setViveRecCount(samples.length);
    if (samples.length === 0) { setStatus('nothing recorded'); return; }
    const path = await pickSaveFile({ defaultPath: 'vive_recording.json' });
    if (!path) { setStatus('save cancelled (kept buffer)'); return; }
    try {
      const r = await recording.save({ kind: 'vive', samples, path });
      setVivePath(r.path);
      setStatus(`saved vive ${r.n} samples → ${path.split('/').pop()}`);
    } catch (e) { setStatus(`save failed: ${e.message}`); }
  }, []);
```

Add `recording` to the imports from `../api/client.js` at the top of the file:

```jsx
import { api, posesWsUrl, pickSaveFile, pickOpenFile, recording } from '../api/client.js';
```

- [ ] **Step 4: Add the Inputs-mode Seg + Vive recording section to the rail**

Locate the existing rail JSX (the left `<div className="rail">`). Find the `<div className="rail-scroll">` block. The existing rail begins with the source pickers (a `<Section title="Source">` for sourceA/B, around line 280-300). At the very top of `<div className="rail-scroll">` — *before* any existing Section — add:

```jsx
            <Section title="Inputs">
              <Seg value={inputsMode} onChange={setInputsMode} full options={[
                {value:'live', label:'live pair'},
                {value:'mcap', label:'vive + mcap'},
              ]}/>
            </Section>
```

Then wrap **the existing** `<Section title="Source">` (the one with `sourceA`/`sourceB`/`oculusIp`/`linkLabel`/`rate`/`connect/disconnect`) plus all the OTHER existing sections under a `{inputsMode === 'live' && (<>...</>)}`. Add a parallel `{inputsMode === 'mcap' && (<>...</>)}` block AFTER the existing wrapped sections, containing only the Vive recording section for now:

```jsx
            {inputsMode === 'mcap' && (
              <>
                <Section title="Vive recording" hint={connected ? `${viveRecCount} samples` : 'not connected'}>
                  <Field label="source">
                    <Seg value={sourceA} onChange={setSourceA} full options={[
                      {value:'mock', label:'mock'},
                      {value:'steamvr', label:'steamvr'},
                    ]}/>
                  </Field>
                  <Field label="device">
                    <select className="select" value={devA} onChange={e => setDevA(e.target.value)}>
                      {devices.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </Field>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                    {connected
                      ? <button className="btn ghost" onClick={disconnect}>disconnect</button>
                      : <button className="btn" onClick={connect}>connect</button>}
                    {recording
                      ? <button className="btn primary" onClick={stopAndSaveRecording}>⏹ stop & save</button>
                      : <button className="btn" disabled={!connected} onClick={startRecording}>● start recording</button>}
                  </div>
                  {vivePath && <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>saved: {vivePath}</div>}
                </Section>
              </>
            )}
```

- [ ] **Step 5: Verify the build**

```bash
cd /home/mi/Calibration && npm run build:renderer
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/tabs/LinkCalibTab.jsx && git commit -m "feat(link): inputs-mode Seg + Vive recording section"
```

---

### Task 9: Renderer — UMI MCAP import section

Adds the second section under `vive + mcap` mode: file picker → list_topics → topic dropdown → import → display loaded count + duration.

**Files:**
- Modify: `renderer/src/tabs/LinkCalibTab.jsx`

- [ ] **Step 1: Add the import handler**

Below the existing `stopAndSaveRecording` callback, add:

```jsx
  const onImportMcap = useCallback(async () => {
    const mcap_path = await pickOpenFile({ filters: [{ name: 'MCAP', extensions: ['mcap'] }] });
    if (!mcap_path) return;
    setStatus('listing topics…');
    try {
      const t = await recording.listTopics(mcap_path);
      const topics = t.topics || [];
      setUmiTopics(topics);
      if (topics.length === 0) { setStatus('no PoseInFrame topics in that mcap'); return; }
      const default_topic = topics.find(x => x.topic === umiTopic) ? umiTopic : topics[0].topic;
      setUmiTopic(default_topic);
      const out_path = await pickSaveFile({ defaultPath: 'umi_recording.json' });
      if (!out_path) { setStatus('import cancelled'); return; }
      setStatus(`importing ${default_topic}…`);
      const r = await recording.importMcap({ mcap_path, topic: default_topic, out_path });
      setUmiPath(r.path);
      setUmiCount(r.count);
      setUmiTimespan(r.t_last - r.t_first);
      setStatus(`imported ${r.count} samples · ${(r.t_last - r.t_first).toFixed(1)}s`);
    } catch (e) { setStatus(`import failed: ${e.message}`); }
  }, [umiTopic]);
```

- [ ] **Step 2: Add the UMI MCAP section to the `mcap` mode block**

Inside the `{inputsMode === 'mcap' && (<>...</>)}` block (added in Task 8), append after the Vive recording section:

```jsx
                <Section title="UMI MCAP" hint={umiCount ? `${umiCount} samples · ${umiTimespan.toFixed(1)}s` : 'not loaded'}>
                  <button className="btn" onClick={onImportMcap}>↓ import mcap</button>
                  {umiTopics.length > 0 && (
                    <Field label="topic">
                      <select className="select" value={umiTopic} onChange={e => setUmiTopic(e.target.value)}>
                        {umiTopics.map(t => <option key={t.topic} value={t.topic}>{t.topic} ({t.n})</option>)}
                      </select>
                    </Field>
                  )}
                  {umiPath && <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>{umiPath}</div>}
                </Section>
```

- [ ] **Step 3: Verify the build**

```bash
cd /home/mi/Calibration && npm run build:renderer
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/tabs/LinkCalibTab.jsx && git commit -m "feat(link): UMI MCAP import section"
```

---

### Task 10: Renderer — Sync + Solve sections + gating

Adds the last two sections of the `vive + mcap` mode rail. Solve is gated on: both files exist, sync ran with `n_pairs ≥ 50`, and rotation diversity ≥ 30° on each side.

**Files:**
- Modify: `renderer/src/tabs/LinkCalibTab.jsx`

- [ ] **Step 1: Add the sync + solve handlers**

After `onImportMcap`, add:

```jsx
  const onSync = useCallback(async () => {
    if (!vivePath) { setStatus('record vive first'); return; }
    if (!umiPath) { setStatus('import mcap first'); return; }
    const out_path = await pickSaveFile({ defaultPath: 'synced.json' });
    if (!out_path) return;
    setStatus('syncing…');
    try {
      const r = await recording.sync({ vive_path: vivePath, umi_path: umiPath, out_path });
      setSyncPath(r.path);
      setSyncDiag({
        delta_t: r.delta_t,
        n_pairs: r.n_pairs,
        vive_rot_deg: r.vive_rot_deg,
        umi_rot_deg: r.umi_rot_deg,
      });
      setStatus(`synced · Δt ${r.delta_t.toFixed(3)}s · ${r.n_pairs} pairs`);
    } catch (e) { setStatus(`sync failed: ${e.message}`); }
  }, [vivePath, umiPath]);

  const onSolveLink = useCallback(async () => {
    if (!syncPath) { setStatus('sync first'); return; }
    setBusy(true);
    setStatus('solving handeye…');
    try {
      const r = await recording.calibrateHandeyePose({ synced_path: syncPath, method: solveMethod });
      setResult(r);
      setStatus(r.ok ? `T_vive_umi · rms ${r.rms.toFixed(3)}° · ${r.message}` : `failed: ${r.message}`);
    } catch (e) { setStatus(`solve failed: ${e.message}`); }
    finally { setBusy(false); }
  }, [syncPath, solveMethod]);
```

- [ ] **Step 2: Compute the gate**

After the `onSolveLink` callback, add:

```jsx
  const solveGate = (() => {
    if (!syncDiag) return 'run sync first';
    if (syncDiag.n_pairs < 50) return `only ${syncDiag.n_pairs} pairs (need ≥ 50)`;
    if (syncDiag.vive_rot_deg < 30) return `vive rotation diversity too low: ${syncDiag.vive_rot_deg.toFixed(1)}°`;
    if (syncDiag.umi_rot_deg < 30) return `umi rotation diversity too low: ${syncDiag.umi_rot_deg.toFixed(1)}°`;
    return null;  // ready
  })();
```

- [ ] **Step 3: Add the Sync + Solve sections**

Inside the `{inputsMode === 'mcap' && (<>...</>)}` block, append after the UMI MCAP section:

```jsx
                <Section title="Sync" hint={syncDiag ? `${syncDiag.n_pairs} pairs · Δt ${syncDiag.delta_t.toFixed(3)}s` : 'not synced'}>
                  <button className="btn" onClick={onSync} disabled={!vivePath || !umiPath}>⚡ sync</button>
                  {syncDiag && (
                    <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)', display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                      <span>Δt</span><span>{syncDiag.delta_t.toFixed(3)} s</span>
                      <span>pairs</span><span>{syncDiag.n_pairs}</span>
                      <span>vive rot</span><span>{syncDiag.vive_rot_deg.toFixed(1)}°</span>
                      <span>umi rot</span><span>{syncDiag.umi_rot_deg.toFixed(1)}°</span>
                    </div>
                  )}
                </Section>
                <Section title="Solve" hint={solveGate ? 'gated' : 'ready'}>
                  <Field label="method">
                    <select className="select" value={solveMethod} onChange={e => setSolveMethod(e.target.value)}>
                      <option value="daniilidis">daniilidis</option>
                      <option value="tsai">tsai</option>
                      <option value="park">park</option>
                      <option value="horaud">horaud</option>
                      <option value="andreff">andreff</option>
                    </select>
                  </Field>
                  <button className="btn primary" onClick={onSolveLink}
                          disabled={!!solveGate || busy}
                          title={solveGate || ''}>
                    Solve T_vive_umi
                  </button>
                  {solveGate && <div className="mono" style={{ fontSize: 10.5, color:'var(--warn)' }}>{solveGate}</div>}
                </Section>
```

- [ ] **Step 4: Verify the build**

```bash
cd /home/mi/Calibration && npm run build:renderer
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/tabs/LinkCalibTab.jsx && git commit -m "feat(link): sync + solve sections with gating in vive+mcap mode"
```

---

### Task 11: End-to-end manual verification

The implementation is complete; this task walks the spec's manual test plan with the user's actual hardware to flush out anything a build-time check missed.

- [ ] **Step 1: Run the app**

```bash
cd /home/mi/Calibration && npm run dev
```

- [ ] **Step 2: Walk the test plan**

For each of the 7 items in the spec's "Manual test plan" section (`docs/superpowers/specs/2026-04-28-link-vive-umi-design.md`):

1. Open LinkCalibTab → switch to `vive + mcap` mode → connect SteamVR → record 30s → stop & save. Verify saved JSON has `kind=vive`, sample count > 500, T is 4×4, ts is recent epoch.
2. Click Import MCAP → select corresponding UMI file → topic dropdown shows `/robot0/vio/eef_pose` → confirm out path → loaded count non-zero.
3. Click Sync → `Δt` small (|Δt| < 1s if NTP-aligned), pair count > 50, both rotation diversities > 30°.
4. Click Solve (Daniilidis default) → 4×4 `T_vive_umi` shown in right rail, per-pair residuals < 5 mm / 1°.
5. Try alternate methods (`tsai`, `park`) → results agree within 2 mm / 0.5°.
6. Save / Load via existing buttons round-trips the calibration.
7. Switch to `live pair` mode → existing flow unchanged, mock pair calibration still solves.

For any failure, fix in the affected task's files and recommit.

- [ ] **Step 3: Stop the app**

Ctrl-C the dev server.
