# Hand-Eye paired image+pose recording — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Hand-Eye tab, attach the latest tracker pose to every captured camera image (manual snap or auto-rate) so the dataset folder is self-contained and feeds the existing AX=XB solver without an out-of-band poses JSON.

**Architecture:** Add a ref-counted `pose_manager` mirroring the existing `source_manager`. Refactor `/poses/stream` to acquire/release through it. Add a `POST /handeye/append_pose` endpoint with atomic read-modify-write for `poses.json`. Extend the existing pose-loader to accept the new `{T, ts}` per-entry shape (back-compat with legacy `[[4x4]]`). On the renderer, the Hand-Eye tab opens a `/poses/stream` WS, keeps the latest pose in a ref, and on every snap calls the new endpoint with that pose.

**Tech Stack:** FastAPI / pytest (backend), React + plain Vite (renderer; no JS test framework — renderer steps verified manually). Reuses `/poses/stream` WS shape from LinkCalibTab.

**Spec:** `docs/superpowers/specs/2026-04-28-handeye-pose-recording-design.md`

---

## File map

**Backend (new):**
- `backend/app/sources/poses/manager.py` — ref-counted `pose_manager.get(key, *, ip=None)` / `release(key)` / `shutdown_all()`. Key shape: `"<source_name>"` for `mock`, `"oculus"`, `"steamvr"`. (IP is per-acquire, not part of the key — only the first acquire creates the source; subsequent ones share it regardless of `ip`.)
- `backend/tests/test_pose_manager.py` — ref-count lifecycle tests.
- `backend/tests/test_handeye_append_pose.py` — endpoint tests (atomic write, meta first-write only, request validation).
- `backend/tests/test_handeye_load_poses_back_compat.py` — loader accepts both shapes.

**Backend (modified):**
- `backend/app/api/routes.py:858-937` — `/poses/stream` WS uses `pose_manager.get/release` instead of `_build_pose_source`.
- `backend/app/api/routes.py` — new `POST /handeye/append_pose` (added after `/recording/save`).
- `backend/app/calib/handeye.py:52-66` — `_load_poses_json` accepts `{T, ts}` per-entry dict in addition to legacy `[[4x4]]`.

**Renderer (modified):**
- `renderer/src/api/client.js` — add `appendHandeyePose` method.
- `renderer/src/tabs/HandEyeTab.jsx` — pose WS client, latest-pose ref, paired-snap path, connect/disconnect UI, lock controls while connected, dataset-panel KV row, status messages, auto-capture rate wiring.

---

## Task 1: `pose_manager` skeleton + tests

**Files:**
- Create: `backend/app/sources/poses/manager.py`
- Create: `backend/tests/test_pose_manager.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_pose_manager.py
"""pose_manager ref-counts PoseSource instances keyed by source name; multiple
get() calls share one underlying client and only the final release() closes it."""
from __future__ import annotations

from app.sources.poses import manager as pose_manager


class FakePose:
    instances: list = []

    def __init__(self, **kw):
        self.kw = kw
        self.closed = False
        FakePose.instances.append(self)

    def hello(self): return {"devices": ["d0"]}
    def poll(self, t): return {"d0": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]}
    def close(self): self.closed = True


def _patch_builders(monkeypatch):
    FakePose.instances = []
    monkeypatch.setattr(pose_manager, "_BUILDERS", {"mock": lambda **kw: FakePose(**kw)})
    monkeypatch.setattr(pose_manager, "_sources", {})
    monkeypatch.setattr(pose_manager, "_refs", {})


def test_get_creates_source_first_time(monkeypatch):
    _patch_builders(monkeypatch)
    src = pose_manager.get("mock")
    assert isinstance(src, FakePose)
    assert pose_manager._refs["mock"] == 1
    assert len(FakePose.instances) == 1


def test_get_shares_instance_across_callers(monkeypatch):
    _patch_builders(monkeypatch)
    a = pose_manager.get("mock")
    b = pose_manager.get("mock")
    assert a is b
    assert pose_manager._refs["mock"] == 2
    assert len(FakePose.instances) == 1


def test_release_closes_only_at_zero(monkeypatch):
    _patch_builders(monkeypatch)
    pose_manager.get("mock")
    pose_manager.get("mock")
    src = FakePose.instances[0]
    pose_manager.release("mock")
    assert src.closed is False
    assert pose_manager._refs["mock"] == 1
    pose_manager.release("mock")
    assert src.closed is True
    assert "mock" not in pose_manager._refs
    assert "mock" not in pose_manager._sources


def test_unknown_source_raises(monkeypatch):
    _patch_builders(monkeypatch)
    import pytest
    with pytest.raises(ValueError, match="unknown pose source"):
        pose_manager.get("nope")


def test_release_unknown_is_noop(monkeypatch):
    _patch_builders(monkeypatch)
    pose_manager.release("never-acquired")  # must not raise
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/mi/Calibration/backend && python -m pytest tests/test_pose_manager.py -v
```
Expected: FAIL — `app.sources.poses.manager` does not exist.

- [ ] **Step 3: Implement `pose_manager`**

```python
# backend/app/sources/poses/manager.py
"""Ref-counted registry of PoseSource instances keyed by source name. Mirrors
sources/manager.py for camera sources. Multiple consumers (e.g. HandEye tab +
LinkCalib tab + telemetry pill) share one underlying client; the source is
torn down only when the last consumer releases it."""
from __future__ import annotations

import logging
import threading
from typing import Callable

from app.sources.poses import PoseSource
from app.sources.poses.mock import MockPoseSource

log = logging.getLogger("calib.pose.mgr")

_sources: dict[str, PoseSource] = {}
_refs: dict[str, int] = {}
_lock = threading.Lock()


def _build_oculus(**kw) -> PoseSource:
    # Lazy import — keeps the vendored submodule + adb client out of the boot path.
    from app.sources.poses.oculus import OculusPoseSource
    return OculusPoseSource(ip_address=kw.get("ip"))


def _build_steamvr(**kw) -> PoseSource:
    from app.sources.poses.steamvr import SteamVRPoseSource
    return SteamVRPoseSource()


_BUILDERS: dict[str, Callable[..., PoseSource]] = {
    "mock":    lambda **kw: MockPoseSource(),
    "oculus":  _build_oculus,
    "steamvr": _build_steamvr,
}


def get(key: str, *, ip: str | None = None) -> PoseSource:
    """Acquire a refcount on the named source. First acquire constructs it
    (passing `ip` to oculus); subsequent acquires share the existing instance
    and ignore `ip` — only the first caller's connection params apply.
    """
    with _lock:
        src = _sources.get(key)
        if src is None:
            builder = _BUILDERS.get(key)
            if builder is None:
                raise ValueError(f"unknown pose source: {key!r}")
            src = builder(ip=ip)
            _sources[key] = src
            _refs[key] = 0
        _refs[key] += 1
    return src


def release(key: str) -> None:
    """Drop a refcount; close and forget the source when it reaches zero."""
    with _lock:
        if key not in _refs:
            return
        _refs[key] -= 1
        if _refs[key] > 0:
            return
        src = _sources.pop(key, None)
        _refs.pop(key, None)
    if src is not None:
        try:
            src.close()
        except Exception:  # pragma: no cover — best-effort teardown
            log.exception("pose source close failed: %s", key)


def shutdown_all() -> None:
    """Forcefully close every live source. Called on app shutdown."""
    with _lock:
        items = list(_sources.items())
        _sources.clear()
        _refs.clear()
    for key, src in items:
        try: src.close()
        except Exception: log.exception("pose source close failed: %s", key)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && python -m pytest tests/test_pose_manager.py -v
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/sources/poses/manager.py backend/tests/test_pose_manager.py
git commit -m "feat(poses): ref-counted pose_manager mirroring source_manager"
```

---

## Task 2: Refactor `/poses/stream` to use `pose_manager`

**Files:**
- Modify: `backend/app/api/routes.py:834-937`
- Modify: `backend/tests/test_pose_hello.py` (only if it constructs sources directly — verify first)

- [ ] **Step 1: Read the existing handler to confirm the diff target**

```bash
sed -n '834,937p' /home/mi/Calibration/backend/app/api/routes.py
```

- [ ] **Step 2: Confirm `test_pose_hello.py` doesn't break**

```bash
cd /home/mi/Calibration/backend && python -m pytest tests/test_pose_hello.py -v
```
Expected: existing tests pass before any change. Read the test file — if it imports `_build_pose_source` directly, note that and update the test in step 5; otherwise no test edit needed.

- [ ] **Step 3: Replace `_build_pose_source` callsite with `pose_manager`**

In `backend/app/api/routes.py`, around lines 834–937:

Remove:
```python
from app.sources.poses import PoseSource
from app.sources.poses.mock import MockPoseSource


def _build_pose_source(source: str, ip_address: str | None) -> PoseSource:
    s = (source or "mock").lower()
    if s == "mock":
        return MockPoseSource()
    if s == "oculus":
        from app.sources.poses.oculus import OculusPoseSource
        return OculusPoseSource(ip_address=ip_address)
    if s == "steamvr":
        from app.sources.poses.steamvr import SteamVRPoseSource
        return SteamVRPoseSource()
    raise ValueError(f"unknown pose source: {source!r}")
```

Add at the top of the WS section (alongside the existing PoseSource import):
```python
from app.sources.poses import PoseSource
from app.sources.poses import manager as pose_manager
```

Inside the `poses_stream` handler, replace the construction loop:
```python
        for name in names:
            try:
                built.append((name, _build_pose_source(name, ip)))
            except Exception as e:
                log.warning("pose source %r failed to init: %s", name, e)
                await ws.send_text(json.dumps({
                    "type": "error",
                    "source": name,
                    "message": str(e),
                }))
                await ws.close(code=1011)
                return
```
with:
```python
        for name in names:
            try:
                built.append((name, pose_manager.get(name, ip=ip)))
            except Exception as e:
                log.warning("pose source %r failed to init: %s", name, e)
                # Release anything we already acquired before bailing out.
                for prior_name, _src in built:
                    pose_manager.release(prior_name)
                built.clear()
                await ws.send_text(json.dumps({
                    "type": "error",
                    "source": name,
                    "message": str(e),
                }))
                await ws.close(code=1011)
                return
```

Replace the `finally` block:
```python
    finally:
        for _name, src in built:
            try: src.close()
            except Exception: log.exception("source close failed")
```
with:
```python
    finally:
        for name, _src in built:
            pose_manager.release(name)
```

- [ ] **Step 4: Add a regression test for the WS handler**

Append to `backend/tests/test_pose_hello.py`:

```python
def test_poses_stream_uses_pose_manager(monkeypatch):
    """The /poses/stream handler must acquire/release through pose_manager so
    a second concurrent client doesn't double-open the underlying source."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.sources.poses import manager as pose_manager

    class FakePose:
        def __init__(self, **kw): self.closed = False
        def hello(self): return {"devices": ["d"]}
        def poll(self, t): return {"d": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]}
        def close(self): self.closed = True

    monkeypatch.setattr(pose_manager, "_sources", {})
    monkeypatch.setattr(pose_manager, "_refs", {})
    monkeypatch.setattr(pose_manager, "_BUILDERS", {"mock": lambda **kw: FakePose()})

    client = TestClient(app)
    with client.websocket_connect("/poses/stream?sources=mock&fps=30") as ws1:
        hello = ws1.receive_json()
        assert hello["type"] == "hello"
        assert pose_manager._refs.get("mock") == 1
        with client.websocket_connect("/poses/stream?sources=mock&fps=30") as ws2:
            ws2.receive_json()  # discard hello
            assert pose_manager._refs.get("mock") == 2
        # ws2 closed — ref drops to 1, source still alive.
        assert pose_manager._refs.get("mock") == 1
    # Both closed — manager evicts.
    assert "mock" not in pose_manager._refs
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && python -m pytest tests/test_pose_hello.py tests/test_pose_manager.py -v
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/routes.py backend/tests/test_pose_hello.py
git commit -m "refactor(poses): /poses/stream acquires through pose_manager"
```

---

## Task 3: Extend `_load_poses_json` to accept `{T, ts}`

**Files:**
- Modify: `backend/app/calib/handeye.py:52-66`
- Create: `backend/tests/test_handeye_load_poses_back_compat.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_handeye_load_poses_back_compat.py
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/mi/Calibration/backend && python -m pytest tests/test_handeye_load_poses_back_compat.py -v
```
Expected: most tests pass for the legacy paths (already supported), the new-shape tests FAIL.

- [ ] **Step 3: Update the loader**

In `backend/app/calib/handeye.py`, replace `_load_poses_json` (lines 52–66) with:

```python
def _load_poses_json(path: str) -> dict[str, np.ndarray]:
    """Read poses keyed by image basename. Accepts two per-entry shapes:

    - legacy:  basename -> 4x4 (or 3x4) nested list
    - new:     basename -> {"T": 4x4 nested list, "ts": float}  (ts optional)

    Returns a dict basename -> 4x4 numpy array. Timestamps are dropped here
    because the existing solver doesn't consume them; they live in the file
    for debug/resync tooling and round-trip cleanly via append_pose.
    """
    with open(path, "r") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError("poses JSON must be a dict keyed by image basename")
    out: dict[str, np.ndarray] = {}
    for k, v in raw.items():
        if isinstance(v, dict):
            if "T" not in v:
                raise ValueError(f"pose entry {k!r} missing 'T'")
            arr = v["T"]
        else:
            arr = v
        M = np.array(arr, dtype=np.float64)
        if M.shape == (4, 4):
            out[os.path.basename(k)] = M
        elif M.shape == (3, 4):
            T = np.eye(4); T[:3] = M; out[os.path.basename(k)] = T
        else:
            raise ValueError(f"pose for {k!r} must be 4x4 or 3x4, got {M.shape}")
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && python -m pytest tests/test_handeye_load_poses_back_compat.py -v
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/calib/handeye.py backend/tests/test_handeye_load_poses_back_compat.py
git commit -m "feat(handeye): load poses with optional per-entry timestamp"
```

---

## Task 4: `POST /handeye/append_pose` endpoint

**Files:**
- Modify: `backend/app/api/routes.py` (add after `/recording/save`)
- Create: `backend/tests/test_handeye_append_pose.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_handeye_append_pose.py
"""POST /handeye/append_pose appends one entry to poses.json (creating it on
first call), writes poses.meta.json on first call only, and uses an atomic
rename so an interrupted write leaves the previous file intact."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app


def _eye4():
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def _post(client, **body):
    return client.post("/handeye/append_pose", json=body)


def test_first_call_creates_poses_and_meta(tmp_path):
    client = TestClient(app)
    poses_path = str(tmp_path / "poses.json")
    r = _post(client,
              poses_path=poses_path,
              basename="f1.png", T=_eye4(), ts=1.0,
              meta={"tracker_source": "mock", "device": "d0", "kind": "hmd"})
    assert r.status_code == 200, r.text
    data = json.loads(Path(poses_path).read_text())
    assert "f1.png" in data
    assert data["f1.png"]["T"] == _eye4()
    assert data["f1.png"]["ts"] == 1.0
    meta = json.loads(Path(tmp_path / "poses.meta.json").read_text())
    assert meta["tracker_source"] == "mock"
    assert meta["device"] == "d0"
    assert meta["kind"] == "hmd"
    assert meta["n"] == 1


def test_second_call_appends_and_updates_meta_count(tmp_path):
    client = TestClient(app)
    poses_path = str(tmp_path / "poses.json")
    meta = {"tracker_source": "mock", "device": "d0", "kind": "hmd"}
    _post(client, poses_path=poses_path, basename="f1.png", T=_eye4(), ts=1.0, meta=meta)
    _post(client, poses_path=poses_path, basename="f2.png", T=_eye4(), ts=2.0, meta=meta)
    data = json.loads(Path(poses_path).read_text())
    assert set(data.keys()) == {"f1.png", "f2.png"}
    meta_on_disk = json.loads(Path(tmp_path / "poses.meta.json").read_text())
    assert meta_on_disk["n"] == 2


def test_meta_only_set_once(tmp_path):
    """Renderer sends `meta` on every call but the backend must keep the
    first-call meta intact even if the renderer's meta drifts later."""
    client = TestClient(app)
    poses_path = str(tmp_path / "poses.json")
    _post(client, poses_path=poses_path, basename="f1.png", T=_eye4(), ts=1.0,
          meta={"tracker_source": "steamvr", "device": "LHR-A", "kind": "hmd"})
    _post(client, poses_path=poses_path, basename="f2.png", T=_eye4(), ts=2.0,
          meta={"tracker_source": "oculus", "device": "quest3", "kind": "ctrl"})
    meta = json.loads(Path(tmp_path / "poses.meta.json").read_text())
    assert meta["tracker_source"] == "steamvr"
    assert meta["device"] == "LHR-A"
    assert meta["kind"] == "hmd"
    assert meta["n"] == 2


def test_missing_fields_rejected(tmp_path):
    client = TestClient(app)
    r = _post(client, basename="f1.png", T=_eye4(), ts=1.0)  # no poses_path
    assert r.status_code == 400
    r = _post(client, poses_path=str(tmp_path / "poses.json"), T=_eye4(), ts=1.0)
    assert r.status_code == 400
    r = _post(client, poses_path=str(tmp_path / "poses.json"), basename="f1.png", ts=1.0)
    assert r.status_code == 400


def test_wrong_T_shape_rejected(tmp_path):
    client = TestClient(app)
    r = _post(client,
              poses_path=str(tmp_path / "poses.json"),
              basename="f1.png", T=[[1, 2, 3]], ts=1.0)
    assert r.status_code == 400


def test_atomic_write_via_rename(tmp_path, monkeypatch):
    """If json.dump succeeds but os.replace fails, poses.json must be
    untouched (or never created). Verifies we use the tmp+rename pattern."""
    client = TestClient(app)
    poses_path = str(tmp_path / "poses.json")
    # Seed with one entry first.
    _post(client, poses_path=poses_path, basename="f1.png", T=_eye4(), ts=1.0,
          meta={"tracker_source": "mock", "device": "d", "kind": "hmd"})
    original = Path(poses_path).read_text()

    import app.api.routes as routes
    real_replace = __import__("os").replace
    calls = {"n": 0}
    def fail_then_succeed(src, dst):
        calls["n"] += 1
        if calls["n"] == 1:  # first replace = poses.json
            raise OSError("simulated failure")
        return real_replace(src, dst)
    monkeypatch.setattr(routes.os, "replace", fail_then_succeed)

    r = _post(client, poses_path=poses_path, basename="f2.png", T=_eye4(), ts=2.0,
              meta={"tracker_source": "mock", "device": "d", "kind": "hmd"})
    assert r.status_code == 500
    assert Path(poses_path).read_text() == original  # untouched
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/mi/Calibration/backend && python -m pytest tests/test_handeye_append_pose.py -v
```
Expected: FAIL — endpoint does not exist (404 from TestClient).

- [ ] **Step 3: Implement the endpoint**

In `backend/app/api/routes.py`, find the existing `/recording/save` route (~line 584) and add immediately **after** that handler:

```python
@router.post("/handeye/append_pose")
async def handeye_append_pose(body: dict) -> dict:
    """Append one paired (image, pose) entry to poses.json next to the
    images. On first call (poses.meta.json absent) writes the meta sidecar
    too. Uses tmp+rename for atomicity so an interrupted call leaves the
    previous file intact."""
    poses_path = body.get("poses_path")
    basename = body.get("basename")
    T = body.get("T")
    ts = body.get("ts")
    meta = body.get("meta") or {}
    if not poses_path or not basename or T is None:
        raise HTTPException(status_code=400, detail="need poses_path + basename + T")
    # Validate T shape: 4x4 nested lists of numbers.
    try:
        arr = np.array(T, dtype=np.float64)
    except Exception:
        raise HTTPException(status_code=400, detail="T must be a numeric 4x4 array")
    if arr.shape != (4, 4):
        raise HTTPException(status_code=400, detail=f"T must be 4x4, got {arr.shape}")

    out_dir = os.path.dirname(poses_path) or "."
    os.makedirs(out_dir, exist_ok=True)

    # Read-modify-write poses.json.
    if os.path.exists(poses_path):
        try:
            with open(poses_path, "r") as f:
                poses_doc = json.load(f)
            if not isinstance(poses_doc, dict):
                raise ValueError("poses.json root must be a dict")
        except (OSError, ValueError, json.JSONDecodeError) as e:
            raise HTTPException(status_code=500, detail=f"read failed: {e}")
    else:
        poses_doc = {}

    entry: dict = {"T": [list(map(float, row)) for row in arr.tolist()]}
    if ts is not None:
        try:
            entry["ts"] = float(ts)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="ts must be numeric")
    poses_doc[basename] = entry

    tmp = poses_path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(poses_doc, f)
        os.replace(tmp, poses_path)
    except OSError as e:
        # Best-effort cleanup of tmp; don't mask the original error.
        try: os.remove(tmp)
        except OSError: pass
        raise HTTPException(status_code=500, detail=f"poses.json write failed: {e}")

    # poses.meta.json — first-write only for source/device/kind, n updated each call.
    meta_path = os.path.join(out_dir, "poses.meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r") as f:
                meta_doc = json.load(f)
        except (OSError, json.JSONDecodeError):
            meta_doc = {}
    else:
        meta_doc = {
            "tracker_source": meta.get("tracker_source"),
            "device": meta.get("device"),
            "kind": meta.get("kind"),
            "started_at": time.time(),
        }
    meta_doc["n"] = len(poses_doc)

    meta_tmp = meta_path + ".tmp"
    try:
        with open(meta_tmp, "w") as f:
            json.dump(meta_doc, f)
        os.replace(meta_tmp, meta_path)
    except OSError as e:
        try: os.remove(meta_tmp)
        except OSError: pass
        raise HTTPException(status_code=500, detail=f"poses.meta.json write failed: {e}")

    return {"ok": True, "n": len(poses_doc), "poses_path": poses_path, "meta_path": meta_path}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && python -m pytest tests/test_handeye_append_pose.py -v
```
Expected: 6 tests pass.

- [ ] **Step 5: Run the full backend suite to confirm nothing else broke**

```bash
cd /home/mi/Calibration/backend && python -m pytest -q
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/routes.py backend/tests/test_handeye_append_pose.py
git commit -m "feat(handeye): POST /handeye/append_pose with atomic write"
```

---

## Task 5: Renderer — `appendHandeyePose` API client method

**Files:**
- Modify: `renderer/src/api/client.js`

- [ ] **Step 1: Add the method**

In `renderer/src/api/client.js`, add inside the `api` object (alongside `snap`, `snapPair`):

```javascript
  appendHandeyePose: ({ poses_path, basename, T, ts, meta }) =>
    request('/handeye/append_pose', {
      method: 'POST',
      body: JSON.stringify({ poses_path, basename, T, ts, meta }),
    }),
```

- [ ] **Step 2: Verify no JS lint/syntax break**

```bash
cd /home/mi/Calibration && npx vite build --config renderer/vite.config.js 2>&1 | tail -20
```
Expected: build succeeds; if it fails, the error message points at the file/line.

- [ ] **Step 3: Commit**

```bash
git add renderer/src/api/client.js
git commit -m "feat(api-client): appendHandeyePose for paired image+pose recording"
```

---

## Task 6: HandEyeTab — pose WS client + latest-pose ref

**Files:**
- Modify: `renderer/src/tabs/HandEyeTab.jsx`

- [ ] **Step 1: Add imports and state**

At the top of `HandEyeTab.jsx`, change:
```javascript
import React, { useState, useMemo, useEffect } from 'react';
```
to:
```javascript
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
```

Add to the existing `import { api, ... }` line:
```javascript
import { api, pickFolder, pickSaveFile, pickOpenFile, posesWsUrl } from '../api/client.js';
```

Inside `HandEyeTab()`, after the existing `const [status, setStatus] = useState('');` line, add:

```javascript
  // Live tracker stream (used to attach pose to each captured image).
  const [connected, setConnected] = useState(false);
  const [poseHz, setPoseHz] = useState(0);
  const [poseStaleMs, setPoseStaleMs] = useState(null);
  const wsRef = useRef(null);
  const latestPoseRef = useRef(null);  // {ts: <epoch_s>, T: [[4x4]], device}
  const poseTickWindowRef = useRef([]); // last ~1s of wall_ts for fps calc
```

- [ ] **Step 2: Add the connect / disconnect helpers**

Just after the new state, add:

```javascript
  const trackerDeviceKey = () => {
    if (trackerSource === 'oculus')  return oculusDevice || (kind === 'ctrl' ? 'controller_R' : 'hmd');
    if (trackerSource === 'steamvr') return steamvrSerial || (kind === 'ctrl' ? 'controller_R' : 'tracker_0');
    return null;
  };

  const onConnectTracker = useCallback(async () => {
    if (wsRef.current) return;
    if (trackerSource === 'file' || trackerSource === 'ros2') {
      setStatus(`${trackerSource} not supported as a live recorder this iteration`);
      return;
    }
    const device = trackerDeviceKey();
    if (!device) { setStatus('pick a tracker device first'); return; }
    setStatus('connecting tracker…');
    try {
      const url = await posesWsUrl({ fps: 30, sources: [trackerSource] });
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); setStatus(`tracker ws open · ${trackerSource}`); };
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        latestPoseRef.current = null;
        setPoseStaleMs(null);
        setPoseHz(0);
      };
      ws.onerror = () => setStatus('tracker ws error');
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'error') { setStatus(`${m.source} error: ${m.message}`); return; }
        if (m.type !== 'sample' || !m.poses) return;
        const T = m.poses[device];
        if (!T) return;
        const ts = (typeof m.wall_ts === 'number') ? m.wall_ts : (Date.now() / 1000);
        latestPoseRef.current = { ts, T, device };
        const win = poseTickWindowRef.current;
        win.push(ts);
        const cutoff = ts - 1.0;
        while (win.length && win[0] < cutoff) win.shift();
      };
    } catch (e) { setStatus(`connect failed: ${e.message}`); }
  }, [trackerSource, oculusDevice, steamvrSerial, kind]);

  const onDisconnectTracker = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    try { ws.close(); } catch {}
    wsRef.current = null;
    setConnected(false);
    latestPoseRef.current = null;
    setPoseStaleMs(null);
    setPoseHz(0);
  }, []);

  // Refresh the staleness/fps readout twice a second from the ref-held buffer.
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => {
      const lp = latestPoseRef.current;
      if (lp) setPoseStaleMs(Math.max(0, Math.round((Date.now() / 1000 - lp.ts) * 1000)));
      setPoseHz(poseTickWindowRef.current.length);
    }, 500);
    return () => clearInterval(id);
  }, [connected]);

  // Always disconnect on unmount.
  useEffect(() => () => onDisconnectTracker(), [onDisconnectTracker]);
```

- [ ] **Step 3: Add UI — connect button + live readout in the Tracker source panel**

Find the `Section title="Tracker source"` block (around line 251). At the very bottom of that `<Section>`, just **before** its closing `</Section>`, insert:

```jsx
            {(trackerSource === 'oculus' || trackerSource === 'steamvr') && (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  {!connected
                    ? <button className="btn primary" onClick={onConnectTracker}>⚡ connect</button>
                    : <button className="btn ghost" onClick={onDisconnectTracker}>⨯ disconnect</button>}
                </div>
                {connected && (
                  <div className="mono" style={{ fontSize: 10.5,
                    color: (poseStaleMs ?? 999) < 200 ? 'var(--ok)' : 'var(--warn)' }}>
                    ● {trackerDeviceKey()} · {poseHz} Hz · {poseStaleMs == null ? '—' : `${poseStaleMs} ms`}
                  </div>
                )}
              </>
            )}
```

- [ ] **Step 4: Lock controls while connected**

In the same `<Section title="Tracker source">`, find the `<Seg ...>` for tracker-source switching (the `right=` prop) and add `disabled={connected}` to it. Update the `<Seg>` primitive call site if needed; check what props it accepts:

```bash
grep -n "function Seg\|export.*Seg\|Seg =" /home/mi/Calibration/renderer/src/components/primitives.jsx | head -5
```

If `Seg` doesn't yet support `disabled`, instead just **conditionally render** the segmented control:

```jsx
right={connected ? null : <Seg value={trackerSource} onChange={setTrackerSource} options={
  TRACKER_SOURCES.map(s => ({ value: s.value, label: s.label.split(' ')[0].toLowerCase() }))
}/>}
```

For the `kind` `<select>` (around line 264), wrap in:
```jsx
              <select className="select" value={kind} disabled={connected}
                onChange={e => setKind(e.target.value)}>
```

For the per-source device pickers (`oculusDevice` `<select>`, `steamvrSerial` `<input>`) add `disabled={connected}` to each.

- [ ] **Step 5: Manual verification**

Run the dev environment and verify the new UI before committing:

```bash
cd /home/mi/Calibration && npm run dev
```
Then in the app:
1. Open Hand-Eye tab.
2. Pick `mock` is not selectable here yet (only oculus/steamvr) — temporarily set `trackerSource` to `oculus` in the picker; the `connect` button appears.
3. Without a real Oculus, click connect. The WS will either fail to init (if oculus deps absent) or open with no device — confirm the status line surfaces the error / connected state without crashing.
4. Confirm the `kind` and tracker-source controls are disabled while connected, re-enabled after disconnect.

Note: this iteration intentionally doesn't add `mock` to the tracker-source picker. If you want to dev-test without hardware, change `TRACKER_SOURCES` temporarily — do **not** commit that.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/tabs/HandEyeTab.jsx
git commit -m "feat(handeye): live tracker WS connect + latest-pose buffer"
```

---

## Task 7: HandEyeTab — paired snap + auto-capture wiring

**Files:**
- Modify: `renderer/src/tabs/HandEyeTab.jsx`

- [ ] **Step 1: Wire the auto-capture state**

Just below the connect/disconnect refs added in Task 6, add:

```javascript
  const [autoCapture, setAutoCapture] = useState(false);
  const [autoCaptureHz, setAutoCaptureHz] = useState(2);
  const [recordedCount, setRecordedCount] = useState(0);
```

- [ ] **Step 2: Replace `onSnap` with the paired version**

Replace the existing `onSnap` (around line 128) with:

```javascript
  const onSnap = async () => {
    let dir = datasetPath;
    if (!dir) {
      const picked = await pickFolder();
      if (!picked) { setStatus('pick a session folder before snapping'); return; }
      setDatasetPath(picked); dir = picked;
    }
    if (!liveDevice) { setStatus('pick a camera first'); return; }

    // Read pose snapshot BEFORE the snap so time skew is bounded by image-write
    // latency, not the snap RPC round trip. lp may be null (image-only snap).
    const lp = connected ? latestPoseRef.current : null;
    if (connected) {
      if (!lp) { setStatus('no pose yet — wait for tracker stream'); return; }
      const ageMs = Math.round((Date.now() / 1000 - lp.ts) * 1000);
      if (ageMs > 200) { setStatus(`pose stale (Δt = ${ageMs} ms) — check tracker`); return; }
    }

    let imagePath;
    try {
      const r = await api.snap(liveDevice, dir);
      imagePath = r.path;
    } catch (e) { setStatus(`snap failed: ${e.message}`); return; }

    const basename = imagePath.split('/').pop();

    if (lp) {
      const posesPathLocal = `${dir}/poses.json`;
      const meta = {
        tracker_source: trackerSource,
        device: lp.device,
        kind,
      };
      let appended = false;
      for (let attempt = 0; attempt < 2 && !appended; attempt++) {
        try {
          const r = await api.appendHandeyePose({
            poses_path: posesPathLocal, basename, T: lp.T, ts: lp.ts, meta,
          });
          appended = true;
          setRecordedCount(r.n);
          if (posesPath !== posesPathLocal) setPosesPath(posesPathLocal);
        } catch (e) {
          if (attempt === 1) {
            setStatus(`image saved, pose append failed: ${e.message}`);
          }
        }
      }
      if (appended) setStatus(`snapped+pose → ${basename}`);
    } else {
      setStatus(`snap (image only — connect tracker for pose) → ${basename}`);
    }

    if (dir === datasetPath) {
      const ls = await api.listDataset(datasetPath);
      setDatasetFiles(ls.files);
      setSelected(ls.files.length);
      setViewMode('frame');
    }
  };
```

- [ ] **Step 3: Drive auto-capture from a timer**

Just after the connect-cleanup `useEffect` from Task 6, add:

```javascript
  useEffect(() => {
    if (!autoCapture) return;
    const period = Math.max(50, Math.round(1000 / Math.max(1, autoCaptureHz)));
    const id = setInterval(() => { onSnap(); }, period);
    return () => clearInterval(id);
  }, [autoCapture, autoCaptureHz, connected, datasetPath, liveDevice, trackerSource, kind, posesPath]);
```

(The dependency list is intentionally wide because `onSnap` closes over a lot of state and we don't want a stale closure.)

- [ ] **Step 4: Wire the existing CaptureControls props**

Find the existing `<CaptureControls ...>` call (around line 320) and replace with:

```jsx
          <CaptureControls
            autoCapture={autoCapture}
            onAuto={setAutoCapture}
            autoRate={autoCaptureHz}
            onAutoRate={setAutoCaptureHz}
            onSnap={onSnap}
            coverage={Math.min(100, datasetFiles.length * 3)}
            coverageCells={gridCells(40, [0,1,3,4,6,7,9,10,12,14,16,17,20,22,23,26,27,30,32,34,35,38,39])}/>
```

If `CaptureControls` does not yet expose `autoRate` / `onAutoRate`, check IntrinsicsTab.jsx for the prop names that the rate slider uses — it was wired there in commit f8e38c3. Use the exact same names this tab uses.

```bash
grep -n "CaptureControls\|autoRate\|onAutoRate" /home/mi/Calibration/renderer/src/tabs/IntrinsicsTab.jsx /home/mi/Calibration/renderer/src/components/panels.jsx | head
```

- [ ] **Step 5: Add the dataset KV row showing the recorded count**

Find the `<Section title="Dataset" ...>` block (around line 241). Inside it, just before the closing `</Section>`, insert:

```jsx
            {recordedCount > 0 && (
              <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>
                poses.json · {recordedCount} entries
              </div>
            )}
```

- [ ] **Step 6: Manual verification**

```bash
cd /home/mi/Calibration && npm run dev
```

Verify the **golden path**:
1. Pick a camera (live device); pick a dataset folder.
2. Pick `oculus` or `steamvr` for tracker source; click connect.
3. While the staleness pill stays green, click Snap → status shows `snapped+pose → snap_…jpg`, dataset panel shows `poses.json · 1 entries`.
4. Toggle auto-capture on at 2 Hz for ~5 s → counter climbs.
5. Open `<dataset>/poses.json` in a text editor: each entry is `{T:[[4x4]], ts: <epoch>}`.
6. Open `<dataset>/poses.meta.json`: contains `tracker_source`, `device`, `kind`, `started_at`, `n`.

**Edge cases:**
- Disconnect tracker, click Snap → image lands but status says "image only".
- Reconnect, force the tracker to drop (kill adb / SteamVR) → staleness goes amber → snap blocks with "pose stale".
- Pick a fresh dataset folder, switch `kind` → snap and confirm a new `poses.meta.json` is written with the new `kind`.

If any of the above misbehaves, fix the bug **before** committing.

- [ ] **Step 7: Commit**

```bash
git add renderer/src/tabs/HandEyeTab.jsx
git commit -m "feat(handeye): paired image+pose snap + auto-capture wiring"
```

---

## Task 8: End-to-end smoke — record then solve without manual JSON load

**Files:** none (verification only)

- [ ] **Step 1: Use the mock pose source for a full record→solve loop**

Temporarily add `mock` to the `TRACKER_SOURCES` array in `HandEyeTab.jsx` so the dev cycle doesn't need real hardware:

```javascript
const TRACKER_SOURCES = [
  { value: 'oculus',  label: 'Oculus Reader' },
  { value: 'ros2',    label: 'ROS2 topic' },
  { value: 'steamvr', label: 'SteamVR' },
  { value: 'file',    label: 'JSON file' },
  { value: 'mock',    label: 'Mock (dev)' },   // remove before commit
];
```

Also extend `trackerDeviceKey()` to return `'tracker_0'` for `'mock'`.

- [ ] **Step 2: Run dev, record ~20 paired samples**

```bash
cd /home/mi/Calibration && npm run dev
```

In the app:
1. Pick a camera with a Charuco board in front of it.
2. Pick a fresh dataset folder.
3. Tracker source = `mock`, click connect, confirm pose readout shows `30 Hz`, sub-200 ms staleness.
4. Auto-capture at 2 Hz for ~10 s → ~20 entries.
5. Disconnect, load camera intrinsics yaml.
6. **Do not** click "pick poses json" — confirm `posesPath` was auto-set after the first sample.
7. Click Solve AX=XB. Expect a result (or a meaningful error if the mock geometry doesn't satisfy AX=XB — which is fine; the goal is the pipeline runs).

- [ ] **Step 3: Revert the dev-only `mock` entry**

Remove the `mock` line from `TRACKER_SOURCES` and the `mock` branch from `trackerDeviceKey`. **Do not commit those.**

- [ ] **Step 4: Final commit (if any cleanups remain)**

```bash
git status
```
Should be clean. If anything is dirty (e.g., status-line copy you tightened during smoke), commit with a short message.

---

## Self-review summary

- **Spec coverage:** every requirement in `docs/superpowers/specs/2026-04-28-handeye-pose-recording-design.md` is covered: pose_manager (Tasks 1–2), poses.json shape extension (Task 3), append_pose endpoint with atomic write + meta (Task 4), api client (Task 5), HandEyeTab WS + UI lock + readout (Task 6), paired snap + auto-capture + dataset KV (Task 7), smoke (Task 8).
- **Placeholder scan:** no TBD/TODO; every code step has the actual code; every test step has assertions; every command has expected output.
- **Type consistency:** `appendHandeyePose` body shape `{poses_path, basename, T, ts, meta}` matches between renderer client (Task 5), endpoint validation (Task 4), and snap callsite (Task 7). `latestPoseRef.current.{ts, T, device}` is set in Task 6 step 2 and consumed in Task 7 step 2 with the same field names.
