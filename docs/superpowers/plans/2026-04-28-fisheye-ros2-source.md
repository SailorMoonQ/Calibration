# Fisheye + Pinhole ROS2 Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "ROS2 topic" image source (sensor_msgs/CompressedImage) to the FisheyeTab and IntrinsicsTab, plumbed through a polymorphic `source_manager`, and add a user-controlled auto-capture rate slider.

**Architecture:** A new `Ros2ImageSource` conforms to the existing `CameraSource` duck-typed interface (`start`, `stop`, `read`, `wait_frame`, `info`, `_latest_seq`, `capture_fps`). `source_manager.get(key)` dispatches by the `ros2:` key prefix. A singleton `ros2_context` owns one `rclpy` Node + executor thread. The renderer composes `liveDevice = "ros2:" + topic` and every existing endpoint works unchanged. A new shared `Ros2TopicPicker` component handles topic discovery + manual entry, used by both intrinsics tabs.

**Tech Stack:** Python 3.10+, FastAPI, rclpy, cv_bridge, OpenCV, NumPy; React 18, Vite; pytest.

**Spec:** `docs/superpowers/specs/2026-04-28-fisheye-ros2-source-design.md`.

---

## File Structure

**New files:**
- `backend/app/sources/ros2_context.py` — singleton rclpy node + executor + topic discovery
- `backend/app/sources/ros2.py` — `Ros2ImageSource` class
- `backend/tests/test_source_manager_dispatch.py` — manager prefix dispatch tests
- `backend/tests/test_ros2_source.py` — end-to-end Ros2ImageSource test (skipped without rclpy)
- `backend/tests/test_ros2_topics_endpoint.py` — `/stream/ros2_topics` endpoint tests
- `renderer/src/components/Ros2TopicPicker.jsx` — shared topic-picker component

**Modified files:**
- `backend/app/sources/manager.py` — prefix dispatch in `get()`; call `ros2_context.shutdown()` from `shutdown_all()`
- `backend/app/api/routes.py` — add `GET /stream/ros2_topics` endpoint
- `renderer/src/api/client.js` — add `listRos2Topics`
- `renderer/src/components/panels.jsx` — make `CaptureControls.live` checkbox conditional on `onLive` prop; add `autoRate` slider
- `renderer/src/tabs/FisheyeTab.jsx` — replace `live | bag` with `live | ros2`; use `Ros2TopicPicker`; wire `autoRate`
- `renderer/src/tabs/IntrinsicsTab.jsx` — same as FisheyeTab

**Untouched (intentional):**
- `renderer/src/components/panels.jsx`'s `SourcePanel` (still used by HandEyeTab + ChainTab)
- `HandEyeTab.jsx`, `ChainTab.jsx`, `ExtrinsicsTab.jsx`, `LinkCalibTab.jsx`, `HandEyeHMDTab.jsx`, `HandEyeCtrlTab.jsx` — out of scope

---

## Task 1: ros2_context — singleton rclpy node and topic discovery

**Files:**
- Create: `backend/app/sources/ros2_context.py`

**Notes:**
- rclpy is imported lazily inside `ensure_started` so the backend boots without a sourced ROS2 environment.
- `ensure_started` is idempotent and thread-safe.
- `list_compressed_image_topics` filters `node.get_topic_names_and_types()` to entries whose type list contains `sensor_msgs/msg/CompressedImage`. Publisher counts come from `node.count_publishers(topic)`.
- The executor spins on a daemon thread so process shutdown doesn't hang.

- [ ] **Step 1: Create ros2_context.py with the public surface**

```python
"""Process-wide rclpy singleton.

Lazy-init on first use. One Node + one MultiThreadedExecutor running on a
daemon thread are shared by every Ros2ImageSource and by the topic-listing
endpoint. rclpy is imported lazily so the backend can boot without a sourced
ROS2 environment; the import error surfaces at the moment the user actually
needs ROS2.
"""
from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from rclpy.node import Node

log = logging.getLogger("calib.ros2")

_lock = threading.Lock()
_node: "Node | None" = None
_executor = None
_thread: threading.Thread | None = None
_started = False


def ensure_started() -> "Node":
    """Lazy-init rclpy. Idempotent. Raises RuntimeError if rclpy is unavailable."""
    global _node, _executor, _thread, _started
    with _lock:
        if _started and _node is not None:
            return _node
        try:
            import rclpy
            from rclpy.executors import MultiThreadedExecutor
            from rclpy.node import Node
        except ImportError as e:
            raise RuntimeError(
                "rclpy unavailable — source ROS2 setup before launching backend"
            ) from e
        if not rclpy.ok():
            rclpy.init(args=None)
        _node = Node("calib_backend")
        _executor = MultiThreadedExecutor()
        _executor.add_node(_node)
        _thread = threading.Thread(
            target=_executor.spin, name="ros2-spin", daemon=True
        )
        _thread.start()
        _started = True
        log.info("ros2 context started · node=calib_backend")
        return _node


def get_node() -> "Node | None":
    """Return the running node, or None if ensure_started has not been called."""
    return _node


def list_compressed_image_topics() -> list[dict]:
    """Filter live graph topics to sensor_msgs/msg/CompressedImage."""
    node = ensure_started()
    out = []
    for topic, types in node.get_topic_names_and_types():
        if "sensor_msgs/msg/CompressedImage" in types:
            out.append({"topic": topic, "n_publishers": node.count_publishers(topic)})
    out.sort(key=lambda x: x["topic"])
    return out


def shutdown() -> None:
    """Tear down the executor + node + rclpy. Safe to call when never started."""
    global _node, _executor, _thread, _started
    with _lock:
        if not _started:
            return
        try:
            import rclpy
        except ImportError:
            return
        if _executor is not None:
            _executor.shutdown()
        if _node is not None:
            _node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
        _node = None
        _executor = None
        _thread = None
        _started = False
        log.info("ros2 context shut down")
```

- [ ] **Step 2: Sanity-check the module imports**

Run: `cd /home/mi/Calibration/backend && .venv/bin/python -c "from app.sources import ros2_context; print('ok')"`
Expected: `ok` (no exception — the rclpy import is deferred to `ensure_started`).

- [ ] **Step 3: Commit**

```bash
git add backend/app/sources/ros2_context.py
git commit -m "feat(sources): rclpy singleton for backend ros2 access"
```

---

## Task 2: Ros2ImageSource — CompressedImage subscriber

**Files:**
- Create: `backend/app/sources/ros2.py`

**Notes:**
- Mirrors the public surface of `CameraSource` (read, wait_frame, info, capture_fps, _latest_seq, _refs, start, stop) so `source_manager` and the route handlers don't need to know which transport is in use.
- Uses cv_bridge (`compressed_imgmsg_to_cv2(msg, 'bgr8')`) so any other codepath that wants the conversion utility has it available.
- QoS is fixed at `qos_profile_sensor_data` (BEST_EFFORT, KEEP_LAST(1), VOLATILE) — what camera drivers publish with.
- `start()`/`stop()` are refcounted: only the 0→1 transition creates the subscription and only 1→0 destroys it.
- Decode failures log once at WARNING and keep the previous good frame.

- [ ] **Step 1: Create ros2.py with the source class**

```python
"""sensor_msgs/CompressedImage subscriber that conforms to the CameraSource interface.

Exposes the same duck-typed surface (start, stop, read, wait_frame, info,
capture_fps, _latest_seq, _refs) so app.api.routes can treat ROS2 topics
and /dev/video* devices identically through source_manager.get().
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Optional

import numpy as np

from app.sources import ros2_context

log = logging.getLogger("calib.source.ros2")


class Ros2ImageSource:
    def __init__(self, topic: str) -> None:
        self.topic = topic
        self._latest: Optional[np.ndarray] = None
        self._latest_ts: float = 0.0
        self._latest_seq: int = 0
        self._lock = threading.Lock()
        self._refs = 0
        self._sub = None
        self._bridge = None
        self._size: tuple[int, int] | None = None  # (w, h)
        self._ticks: deque[float] = deque(maxlen=90)
        self._decode_warned = False

    def start(self) -> None:
        with self._lock:
            self._refs += 1
            if self._sub is not None:
                return
            node = ros2_context.ensure_started()
            from cv_bridge import CvBridge
            from rclpy.qos import qos_profile_sensor_data
            from sensor_msgs.msg import CompressedImage
            self._bridge = CvBridge()
            self._sub = node.create_subscription(
                CompressedImage, self.topic, self._on_msg, qos_profile_sensor_data
            )
            log.info("ros2 subscribed · %s", self.topic)

    def _on_msg(self, msg) -> None:
        try:
            frame = self._bridge.compressed_imgmsg_to_cv2(msg, "bgr8")
        except Exception as e:
            if not self._decode_warned:
                log.warning("ros2 decode failed on %s: %s", self.topic, e)
                self._decode_warned = True
            return
        if frame is None:
            return
        h, w = frame.shape[:2]
        now = time.time()
        with self._lock:
            self._latest = frame
            self._latest_ts = now
            self._latest_seq += 1
            self._size = (w, h)
            self._ticks.append(now)

    def stop(self) -> None:
        with self._lock:
            self._refs = max(0, self._refs - 1)
            if self._refs > 0 or self._sub is None:
                return
            node = ros2_context.get_node()
            if node is not None:
                try:
                    node.destroy_subscription(self._sub)
                except Exception as e:  # pragma: no cover
                    log.debug("destroy_subscription failed: %s", e)
            self._sub = None
            self._bridge = None
            self._latest = None
            log.info("ros2 unsubscribed · %s", self.topic)

    def read(self) -> Optional[np.ndarray]:
        with self._lock:
            return None if self._latest is None else self._latest.copy()

    def wait_frame(self, timeout: float = 2.0) -> bool:
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self._lock:
                if self._latest is not None:
                    return True
            time.sleep(0.02)
        return False

    def capture_fps(self) -> float:
        cutoff = time.time() - 2.0
        with self._lock:
            recent = [t for t in self._ticks if t >= cutoff]
        if len(recent) < 2:
            return 0.0
        span = recent[-1] - recent[0]
        return (len(recent) - 1) / span if span > 0 else 0.0

    def info(self) -> dict:
        with self._lock:
            sub_open = self._sub is not None
            size = self._size
        if not sub_open:
            return {"device": f"ros2:{self.topic}", "open": False}
        if size is None:
            return {
                "device": f"ros2:{self.topic}",
                "open": True,
                "width": 0, "height": 0,
                "raw_width": 0, "raw_height": 0,
                "clipped": False,
                "fps_advertised": 0.0,
                "capture_fps": 0.0,
                "latest_seq": self._latest_seq,
            }
        w, h = size
        return {
            "device": f"ros2:{self.topic}",
            "open": True,
            "width": w, "height": h,
            "raw_width": w, "raw_height": h,
            "clipped": False,
            "fps_advertised": 0.0,
            "capture_fps": round(self.capture_fps(), 2),
            "latest_seq": self._latest_seq,
        }
```

- [ ] **Step 2: Sanity-check the module imports**

Run: `cd /home/mi/Calibration/backend && .venv/bin/python -c "from app.sources.ros2 import Ros2ImageSource; print('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/sources/ros2.py
git commit -m "feat(sources): Ros2ImageSource — CompressedImage subscriber"
```

---

## Task 3: source_manager prefix dispatch (TDD)

**Files:**
- Create: `backend/tests/test_source_manager_dispatch.py`
- Modify: `backend/app/sources/manager.py`

**Notes:**
- The dispatch test mocks `Ros2ImageSource` so it doesn't need rclpy installed.
- Refcount semantics — calling `get(key)` twice returns the same instance with `_refs == 2` — must hold for both transports.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_source_manager_dispatch.py
"""manager.get(key) dispatches CameraSource for /dev/video* and Ros2ImageSource
for ros2:<topic>; both are refcounted across repeat get() calls."""
from __future__ import annotations

from unittest.mock import patch

from app.sources import manager


def test_get_video_path_returns_camera_source(monkeypatch):
    """Plain device paths still go to CameraSource (default branch unchanged)."""
    instances = []

    class FakeCamera:
        def __init__(self, device): instances.append(device); self._refs = 0
        def start(self): self._refs += 1
        def stop(self): self._refs -= 1

    monkeypatch.setattr(manager, "CameraSource", FakeCamera)
    monkeypatch.setattr(manager, "_sources", {})

    src = manager.get("/dev/video0")
    assert isinstance(src, FakeCamera)
    assert instances == ["/dev/video0"]
    assert src._refs == 1
    src2 = manager.get("/dev/video0")
    assert src is src2
    assert src._refs == 2


def test_get_ros2_prefix_returns_ros2_source(monkeypatch):
    """ros2:<topic> instantiates Ros2ImageSource with the topic stripped of the
    ros2: prefix, refcounted same as CameraSource."""
    instances = []

    class FakeRos2:
        def __init__(self, topic): instances.append(topic); self._refs = 0
        def start(self): self._refs += 1
        def stop(self): self._refs -= 1

    monkeypatch.setattr(manager, "_sources", {})
    with patch("app.sources.ros2.Ros2ImageSource", FakeRos2):
        src = manager.get("ros2:/camera/image_raw/compressed")
        assert isinstance(src, FakeRos2)
        assert instances == ["/camera/image_raw/compressed"]
        assert src._refs == 1
        src2 = manager.get("ros2:/camera/image_raw/compressed")
        assert src is src2
        assert src._refs == 2


def test_release_decrements_refcount(monkeypatch):
    """release() pairs with get() — the refcount must come back down."""
    class FakeCamera:
        def __init__(self, device): self._refs = 0
        def start(self): self._refs += 1
        def stop(self): self._refs -= 1

    monkeypatch.setattr(manager, "CameraSource", FakeCamera)
    monkeypatch.setattr(manager, "_sources", {})

    src = manager.get("/dev/video0")
    manager.get("/dev/video0")
    assert src._refs == 2
    manager.release("/dev/video0")
    assert src._refs == 1
    manager.release("/dev/video0")
    assert src._refs == 0
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/mi/Calibration/backend && .venv/bin/pytest tests/test_source_manager_dispatch.py -v`
Expected: FAIL on `test_get_ros2_prefix_returns_ros2_source` (manager.get does not yet branch on the prefix).

- [ ] **Step 3: Patch manager.py to dispatch on prefix**

```python
# backend/app/sources/manager.py
"""Singleton registry of image sources keyed by an opaque string. /dev/video* keys
go to CameraSource (USB); ros2:<topic> keys go to Ros2ImageSource. Refcount-aware
start/stop so multiple consumers share one capture."""
from __future__ import annotations

import glob
import logging
import threading

from app.sources.opencv import CameraSource

log = logging.getLogger("calib.source.mgr")

_sources: dict = {}
_lock = threading.Lock()

ROS2_PREFIX = "ros2:"


def get(key: str):
    with _lock:
        src = _sources.get(key)
        if src is None:
            if key.startswith(ROS2_PREFIX):
                # Lazy import keeps rclpy out of the boot path; surfaces the
                # rclpy-missing error only when the user actually picks ros2.
                from app.sources.ros2 import Ros2ImageSource
                src = Ros2ImageSource(key[len(ROS2_PREFIX):])
            else:
                src = CameraSource(key)
            _sources[key] = src
    src.start()
    return src


def release(key: str) -> None:
    with _lock:
        src = _sources.get(key)
    if src:
        src.stop()


def list_devices() -> list[dict]:
    """USB cameras only — ROS2 topic listing is a separate endpoint so the
    renderer doesn't have to disambiguate transports at every call site."""
    paths = sorted(glob.glob("/dev/video*"))
    return [{"device": p, "label": p} for p in paths]


def shutdown_all() -> None:
    with _lock:
        items = list(_sources.items())
        _sources.clear()
    for _key, src in items:
        src._refs = 1  # force a single decrement to close
        src.stop()
    # Tear down the rclpy context if it was ever started. Safe to call when
    # never started (the module checks _started internally).
    try:
        from app.sources import ros2_context
        ros2_context.shutdown()
    except ImportError:
        pass
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/mi/Calibration/backend && .venv/bin/pytest tests/test_source_manager_dispatch.py -v`
Expected: 3 passed.

- [ ] **Step 5: Run the rest of the backend test suite to confirm no regressions**

Run: `cd /home/mi/Calibration/backend && .venv/bin/pytest -x`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add backend/app/sources/manager.py backend/tests/test_source_manager_dispatch.py
git commit -m "feat(sources): polymorphic source_manager dispatch by key prefix"
```

---

## Task 4: GET /stream/ros2_topics endpoint (TDD)

**Files:**
- Create: `backend/tests/test_ros2_topics_endpoint.py`
- Modify: `backend/app/api/routes.py`

**Notes:**
- The 503-on-rclpy-missing path is the most common runtime failure the user will see, so it gets explicit test coverage.
- Tests mock `ros2_context.list_compressed_image_topics` so they don't need rclpy.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_ros2_topics_endpoint.py
"""GET /stream/ros2_topics — happy path returns discovered topics; rclpy-missing
returns 503 with a clear hint."""
from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


def test_ros2_topics_happy_path():
    fake = [
        {"topic": "/camera/image_raw/compressed", "n_publishers": 1},
        {"topic": "/cam0/compressed", "n_publishers": 2},
    ]
    with patch(
        "app.sources.ros2_context.list_compressed_image_topics",
        return_value=fake,
    ):
        client = TestClient(app)
        r = client.get("/stream/ros2_topics")
    assert r.status_code == 200
    body = r.json()
    assert body["topics"] == fake


def test_ros2_topics_503_when_rclpy_missing():
    """A clear, actionable error message rather than an opaque 500."""
    with patch(
        "app.sources.ros2_context.list_compressed_image_topics",
        side_effect=RuntimeError(
            "rclpy unavailable — source ROS2 setup before launching backend"
        ),
    ):
        client = TestClient(app)
        r = client.get("/stream/ros2_topics")
    assert r.status_code == 503
    assert "rclpy unavailable" in r.json()["detail"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/mi/Calibration/backend && .venv/bin/pytest tests/test_ros2_topics_endpoint.py -v`
Expected: FAIL — endpoint does not exist (404).

- [ ] **Step 3: Add the endpoint to routes.py**

Add the import (near the top of `backend/app/api/routes.py`, alongside the existing `from app.sources import manager as source_manager`):

```python
from app.sources import ros2_context
```

Add the handler immediately after `stream_devices` (around line 47) so it sits next to its sibling:

```python
@router.get("/stream/ros2_topics")
async def stream_ros2_topics() -> dict:
    """Live discovery of sensor_msgs/CompressedImage topics on the ROS2 graph.
    503 when rclpy isn't importable so the renderer can show a clear hint."""
    try:
        topics = ros2_context.list_compressed_image_topics()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"topics": topics}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/mi/Calibration/backend && .venv/bin/pytest tests/test_ros2_topics_endpoint.py -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/routes.py backend/tests/test_ros2_topics_endpoint.py
git commit -m "feat(api): GET /stream/ros2_topics for ros2 image topic discovery"
```

---

## Task 5: End-to-end Ros2ImageSource test (skippable)

**Files:**
- Create: `backend/tests/test_ros2_source.py`

**Notes:**
- This test requires a working `rclpy` + `cv_bridge` install. CI runs without ROS2 will skip it via `pytest.importorskip`.
- Uses a real publisher in the same process so we exercise the actual `_on_msg` callback path.
- Cleans up rclpy state at teardown so test order doesn't matter.

- [ ] **Step 1: Write the test**

```python
# backend/tests/test_ros2_source.py
"""End-to-end test for Ros2ImageSource: publish a JPEG-encoded CompressedImage
into a real rclpy graph, assert the source decodes it. Skipped automatically
when rclpy/cv_bridge aren't installed."""
from __future__ import annotations

import time

import cv2
import numpy as np
import pytest

rclpy = pytest.importorskip("rclpy")
pytest.importorskip("cv_bridge")
pytest.importorskip("sensor_msgs.msg")

from sensor_msgs.msg import CompressedImage  # noqa: E402

from app.sources import ros2_context  # noqa: E402
from app.sources.ros2 import Ros2ImageSource  # noqa: E402


@pytest.fixture
def ros2_node():
    node = ros2_context.ensure_started()
    yield node
    ros2_context.shutdown()


def test_compressed_image_round_trip(ros2_node):
    topic = "/test/calib/compressed"
    src = Ros2ImageSource(topic)
    src.start()
    try:
        # Build a publisher inside the same node so we don't need a second context.
        pub = ros2_node.create_publisher(CompressedImage, topic, 10)
        rgb = np.full((48, 64, 3), (10, 200, 30), dtype=np.uint8)
        ok, jpg = cv2.imencode(".jpg", rgb)
        assert ok
        msg = CompressedImage()
        msg.format = "jpeg"
        msg.data = jpg.tobytes()
        # Push a handful of messages — sensor QoS is best-effort, occasional drops are fine.
        deadline = time.time() + 3.0
        while time.time() < deadline:
            pub.publish(msg)
            if src.wait_frame(timeout=0.2):
                break
        frame = src.read()
        assert frame is not None
        assert frame.shape == (48, 64, 3)
        info = src.info()
        assert info["open"] is True
        assert info["width"] == 64 and info["height"] == 48
    finally:
        src.stop()
```

- [ ] **Step 2: Run the test**

Run: `cd /home/mi/Calibration/backend && .venv/bin/pytest tests/test_ros2_source.py -v`
Expected: PASS if rclpy + cv_bridge are installed; SKIPPED otherwise. Either outcome is acceptable.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_ros2_source.py
git commit -m "test(sources): end-to-end Ros2ImageSource decode round-trip"
```

---

## Task 6: Frontend api client — listRos2Topics

**Files:**
- Modify: `renderer/src/api/client.js`

- [ ] **Step 1: Add `listRos2Topics` to the api object**

In `renderer/src/api/client.js`, locate the `api` object (starts at line 22) and add the new method right after `listStreamDevices`:

```js
  listStreamDevices: () => request('/stream/devices'),
  listRos2Topics: () => request('/stream/ros2_topics'),
```

- [ ] **Step 2: Commit**

```bash
git add renderer/src/api/client.js
git commit -m "feat(api-client): listRos2Topics for the ros2 source picker"
```

---

## Task 7: Ros2TopicPicker shared component

**Files:**
- Create: `renderer/src/components/Ros2TopicPicker.jsx`

**Notes:**
- Self-contained: fetches on mount, stores its own `topics`, `manual`, `err` state.
- Empty-list and rclpy-missing both render an inline hint so the user knows what to do; the manual entry stays usable in both cases.
- Calling `onTopic(t)` is the one effect the parent cares about — the parent maps it to `liveDevice = "ros2:" + t`.

- [ ] **Step 1: Create the component**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Field } from './primitives.jsx';
import { api } from '../api/client.js';

export function Ros2TopicPicker({ topic, onTopic }) {
  const [topics, setTopics] = useState([]);
  const [manual, setManual] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchTopics = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listRos2Topics();
      setTopics(r.topics || []);
    } catch (e) {
      setErr(e?.message || String(e));
      setTopics([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTopics(); }, [fetchTopics]);

  const onUseManual = () => {
    const t = manual.trim();
    if (t) onTopic(t);
  };

  return (
    <>
      <Field label="topic">
        <select className="select" value={topic}
                onChange={e => onTopic(e.target.value)}>
          <option value="">— none —</option>
          {topics.map(t => (
            <option key={t.topic} value={t.topic}>
              {t.topic} ({t.n_publishers})
            </option>
          ))}
        </select>
      </Field>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
        <button className="btn ghost" onClick={fetchTopics} disabled={loading}>
          ↻ {loading ? 'scanning…' : 'rescan'}
        </button>
        <div/>
      </div>
      {err && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--err)', marginTop: 2 }}>
          {/* Surface the 503 hint verbatim — it's already user-readable. */}
          {/rclpy unavailable/.test(err)
            ? 'rclpy unavailable — source ROS2 setup before launching backend'
            : err}
        </div>
      )}
      {!err && topics.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>
          no CompressedImage topics found · use manual entry below
        </div>
      )}
      <Field label="manual">
        <div style={{ display:'flex', gap: 6, width: '100%' }}>
          <input className="input" style={{ flex: 1 }} value={manual}
                 placeholder="/camera/image_raw/compressed"
                 onChange={e => setManual(e.target.value)}/>
          <button className="btn" onClick={onUseManual} disabled={!manual.trim()}>use</button>
        </div>
      </Field>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add renderer/src/components/Ros2TopicPicker.jsx
git commit -m "feat(ui): Ros2TopicPicker — discovery dropdown + manual entry"
```

---

## Task 8: CaptureControls — make `live` checkbox optional, add `autoRate` slider

**Files:**
- Modify: `renderer/src/components/panels.jsx`

**Notes:**
- `live` checkbox stays for `HandEyeTab` and `ChainTab` callers. Hide it only when `onLive` is not passed.
- `autoRate` slider only renders when `autoCapture` is on, so the panel doesn't grow when the toggle is off.
- Slider range 0.2 s – 3.0 s in 0.1 s steps; integer-100x mapping keeps the `<input type="range">` clean.
- Show `(≈Nfps)` next to the seconds value as a readability aid.

- [ ] **Step 1: Patch `CaptureControls`**

Replace the existing `CaptureControls` function (panels.jsx:107-128) with:

```jsx
export function CaptureControls({
  live, onLive,
  autoCapture, onAuto,
  autoRate, onAutoRate,
  onSnap, onDrop,
  coverage, coverageCells,
}) {
  const rate = typeof autoRate === 'number' ? autoRate : 0.5;
  const fps = rate > 0 ? (1 / rate) : 0;
  return (
    <Section title="Capture" hint="live feed">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {onLive
          ? <Chk checked={live} onChange={onLive}>live stream</Chk>
          : <div/>}
        <Chk checked={autoCapture} onChange={onAuto}>auto-capture</Chk>
      </div>
      {autoCapture && onAutoRate && (
        <Field label={`auto rate · ${rate.toFixed(1)}s (≈${fps.toFixed(1)} fps)`}>
          <div className="slider-row">
            <input type="range" min="20" max="300" step="10"
                   value={Math.round(rate * 100)}
                   onChange={e => onAutoRate(+e.target.value / 100)}/>
            <span className="mono">{rate.toFixed(1)}s</span>
          </div>
        </Field>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <button className="btn" onClick={onSnap}>⌁ snap frame</button>
        <button className="btn danger" onClick={onDrop} disabled={!onDrop}>⌧ drop selected</button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <CoverageGrid cells={coverageCells}/>
        <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.45 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>coverage</div>
          <div style={{ fontFamily: 'JetBrains Mono', fontSize: 16, fontWeight: 500, color: 'var(--text)' }}>{coverage}%</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>capture more<br/>in empty cells</div>
        </div>
      </div>
    </Section>
  );
}
```

- [ ] **Step 2: Verify the renderer still builds**

Run: `cd /home/mi/Calibration && node_modules/.bin/vite build --mode development -l warn` (or whichever build command the project uses — check `package.json` if unsure).
Expected: build succeeds with no errors.

If the build command above isn't right, use whatever `npm run build` resolves to per `/home/mi/Calibration/package.json`.

- [ ] **Step 3: Commit**

```bash
git add renderer/src/components/panels.jsx
git commit -m "feat(panels): conditional live checkbox + auto-capture rate slider"
```

---

## Task 9: FisheyeTab — replace `live | bag` with `live | ros2`, wire autoRate

**Files:**
- Modify: `renderer/src/tabs/FisheyeTab.jsx`

**Notes:**
- `liveDevice = "ros2:" + topic` is the single point of integration. Every existing API call (`api.streamInfo`, `api.snap`, mjpeg URLs) flows through unchanged.
- Switching mode resets both `liveDevice` and `ros2Topic` so stale state from the other transport doesn't leak.
- The `bag` UI block is deleted, including the now-unused `bagPath` state.
- `live` flag passed to CaptureControls is dropped (the `live | bag` toggle no longer exists at this level), so we omit `live`/`onLive` props.
- `autoRate` joins the `useCallback` dep list of `onAutoMeta` so the closure picks up rate changes.

- [ ] **Step 1: Add new state and remove `live`/`bagPath`**

In `FisheyeTab.jsx`, find the state block (lines 18-30 in the current file) and replace these specific lines:

Replace:
```jsx
  const [live, setLive] = useState(true);
```
with:
```jsx
  const [sourceMode, setSourceMode] = useState('live');  // 'live' | 'ros2'
  const [ros2Topic, setRos2Topic] = useState('');
```

Remove the line `const [bagPath, setBagPath] = useState('');` entirely.

Add after the `autoCapture` state:
```jsx
  const [autoRate, setAutoRate] = useState(0.5);  // seconds between auto-snaps
```

- [ ] **Step 2: Add the import for the topic picker**

Near the top of the file (after the `LiveDetectedFrame` import on line 7), add:

```jsx
import { Ros2TopicPicker } from '../components/Ros2TopicPicker.jsx';
```

- [ ] **Step 3: Update `onAutoMeta` to use `autoRate`**

In the `onAutoMeta` callback (around line 174-208), replace the line:

```js
    if (now - lastAutoSnapRef.current < 500) return;  // 0.5s debounce
```

with:

```js
    if (now - lastAutoSnapRef.current < autoRate * 1000) return;  // user-tuned debounce
```

Then update the `useCallback` dep list at the bottom of `onAutoMeta` from:

```js
  }, [autoCapture, liveDevice, datasetPath]);
```

to:

```js
  }, [autoCapture, liveDevice, datasetPath, autoRate]);
```

- [ ] **Step 4: Replace the Source Section body**

Locate the Source Section (lines 466-518). Replace the whole `<Section title="Source" …>…</Section>` block with:

```jsx
          <Section
            title="Source"
            hint={sourceMode === 'live'
              ? (streamInfo?.open
                  ? `${streamInfo.width}×${streamInfo.height} · ${streamInfo.capture_fps?.toFixed(1) ?? '—'} fps`
                  : (liveDevice || 'no device'))
              : (ros2Topic || 'no topic')
            }
            right={<Seg
              value={sourceMode}
              onChange={(v) => {
                setSourceMode(v);
                setLiveDevice('');
                setRos2Topic('');
              }}
              options={[
                { value: 'live', label: 'live' },
                { value: 'ros2', label: 'ros2' },
              ]}/>}
          >
            {sourceMode === 'live' ? (
              <>
                <Field label="device">
                  <select className="select" value={liveDevice} onChange={e => setLiveDevice(e.target.value)}>
                    <option value="">— none —</option>
                    {devices.map(d => <option key={d.device} value={d.device}>{d.label}</option>)}
                  </select>
                </Field>
                {streamInfo?.open && (
                  <div className="mono" style={{ fontSize: 11, color:'var(--text-3)', display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                    <span>resolution</span><span style={{ color:'var(--text-1)' }}>{streamInfo.width} × {streamInfo.height}</span>
                    {streamInfo.clipped && (
                      <>
                        <span>raw</span>
                        <span style={{ color:'var(--text-3)' }}>
                          {streamInfo.raw_width} × {streamInfo.raw_height}
                          <span style={{ color:'var(--warn)', marginLeft: 6 }}>· clipped</span>
                        </span>
                      </>
                    )}
                    <span>fps (measured)</span><span style={{ color:'var(--text-1)' }}>{streamInfo.capture_fps?.toFixed(2) ?? '—'}</span>
                    <span>fps (advertised)</span><span style={{ color:'var(--text-1)' }}>{streamInfo.fps_advertised?.toFixed(0) ?? '—'}</span>
                  </div>
                )}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  <button className="btn" onClick={() => setViewMode('live')}>👁 live preview</button>
                  <button className="btn ghost" onClick={() => api.listStreamDevices().then(r => setDevices(r.cameras || []))}>↻ rescan</button>
                </div>
              </>
            ) : (
              <>
                <Ros2TopicPicker
                  topic={ros2Topic}
                  onTopic={(t) => { setRos2Topic(t); setLiveDevice(t ? 'ros2:' + t : ''); }}/>
                {streamInfo?.open && (
                  <div className="mono" style={{ fontSize: 11, color:'var(--text-3)', display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                    <span>resolution</span><span style={{ color:'var(--text-1)' }}>{streamInfo.width} × {streamInfo.height}</span>
                    <span>fps (measured)</span><span style={{ color:'var(--text-1)' }}>{streamInfo.capture_fps?.toFixed(2) ?? '—'}</span>
                  </div>
                )}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  <button className="btn" onClick={() => setViewMode('live')}>👁 live preview</button>
                  <div/>
                </div>
              </>
            )}
          </Section>
```

- [ ] **Step 5: Update the CaptureControls call site**

Find the `<CaptureControls …/>` call (around line 556-566). Replace it with:

```jsx
          <CaptureControls
            autoCapture={autoCapture}
            onAuto={(v) => {
              setAutoCapture(v);
              if (v) setLiveDetect(true);
            }}
            autoRate={autoRate}
            onAutoRate={setAutoRate}
            onSnap={onSnap} onDrop={onDrop}
            coverage={coverage.percent} coverageCells={coverage.cells}/>
```

(Note: the `live` and `onLive` props are intentionally omitted — `CaptureControls` will hide its own `live stream` checkbox.)

- [ ] **Step 6: Build and run a smoke test**

Run: `cd /home/mi/Calibration && npm run build` (or `npm run dev` if the project uses a dev server).
Expected: builds without errors. Open the running app, navigate to the Fisheye tab, confirm the Source section now shows `live | ros2`. Switching to `ros2` shows the topic picker; switching back shows the original device dropdown.

- [ ] **Step 7: Commit**

```bash
git add renderer/src/tabs/FisheyeTab.jsx
git commit -m "feat(fisheye): ros2 topic source + auto-capture rate slider"
```

---

## Task 10: IntrinsicsTab — same source toggle + autoRate wiring

**Files:**
- Modify: `renderer/src/tabs/IntrinsicsTab.jsx`

**Notes:**
- IntrinsicsTab's Source section is shorter than FisheyeTab's (no streamInfo readout). The replacement reflects that.
- The 500 ms debounce sits at line 159 in this file (same logical spot).

- [ ] **Step 1: Add new state and remove `live`**

Replace:
```jsx
  const [live, setLive] = useState(true);
```
with:
```jsx
  const [sourceMode, setSourceMode] = useState('live');  // 'live' | 'ros2'
  const [ros2Topic, setRos2Topic] = useState('');
```

Add after the `autoCapture` state (the existing `setAuto`):
```jsx
  const [autoRate, setAutoRate] = useState(0.5);
```

- [ ] **Step 2: Import the topic picker**

After the `LiveDetectedFrame` import (line 7):

```jsx
import { Ros2TopicPicker } from '../components/Ros2TopicPicker.jsx';
```

- [ ] **Step 3: Update `onAutoMeta` to use `autoRate`**

Replace:
```js
    if (now - lastAutoSnapRef.current < 500) return;
```
with:
```js
    if (now - lastAutoSnapRef.current < autoRate * 1000) return;
```

Update the `useCallback` dep list at the bottom of `onAutoMeta` from:

```js
  }, [autoCapture, liveDevice, datasetPath]);
```

to:

```js
  }, [autoCapture, liveDevice, datasetPath, autoRate]);
```

- [ ] **Step 4: Replace the Source Section body**

Locate the Source Section (lines 401-418). Replace the whole `<Section title="Source" …>…</Section>` block with:

```jsx
          <Section
            title="Source"
            hint={sourceMode === 'live'
              ? (liveDevice || 'no device')
              : (ros2Topic || 'no topic')
            }
            right={<Seg
              value={sourceMode}
              onChange={(v) => {
                setSourceMode(v);
                setLiveDevice('');
                setRos2Topic('');
              }}
              options={[
                { value: 'live', label: 'live' },
                { value: 'ros2', label: 'ros2' },
              ]}/>}
          >
            {sourceMode === 'live' ? (
              <>
                <Field label="device">
                  <select className="select" value={liveDevice} onChange={e => setLiveDevice(e.target.value)}>
                    <option value="">— none —</option>
                    {devices.map(d => <option key={d.device} value={d.device}>{d.label}</option>)}
                  </select>
                </Field>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  <button className="btn" onClick={() => setViewMode('live')}>👁 live preview</button>
                  <button className="btn ghost" onClick={() => api.listStreamDevices().then(r => setDevices(r.cameras || []))}>↻ rescan</button>
                </div>
              </>
            ) : (
              <>
                <Ros2TopicPicker
                  topic={ros2Topic}
                  onTopic={(t) => { setRos2Topic(t); setLiveDevice(t ? 'ros2:' + t : ''); }}/>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  <button className="btn" onClick={() => setViewMode('live')}>👁 live preview</button>
                  <div/>
                </div>
              </>
            )}
          </Section>
```

- [ ] **Step 5: Update the CaptureControls call site**

Find the `<CaptureControls …/>` call (around line 445-449). Replace it with:

```jsx
          <CaptureControls
            autoCapture={autoCapture}
            onAuto={(v) => { setAuto(v); if (v) setLiveDetect(true); }}
            autoRate={autoRate}
            onAutoRate={setAutoRate}
            onSnap={onSnap} onDrop={onDrop}
            coverage={coverage.percent} coverageCells={coverage.cells}/>
```

- [ ] **Step 6: Build and smoke test**

Run: `cd /home/mi/Calibration && npm run build`
Expected: builds without errors. In the running app, navigate to the Pinhole tab and confirm the same `live | ros2` toggle behaves identically.

- [ ] **Step 7: Commit**

```bash
git add renderer/src/tabs/IntrinsicsTab.jsx
git commit -m "feat(intrinsics): ros2 topic source + auto-capture rate slider"
```

---

## Task 11: End-to-end smoke test (manual)

**Files:** none

**Notes:** This is the user-facing acceptance check. Document the run in the commit log of the PR description, not in the codebase.

- [ ] **Step 1: Start a fake CompressedImage publisher**

In a ROS2-sourced shell:

```bash
ros2 run image_publisher image_publisher_node /tmp/test.jpg --ros-args -p use_sim_time:=false
```

(Substitute any JPEG file you have on disk.) Confirm with `ros2 topic list -t` that `/image_raw/compressed` appears with type `sensor_msgs/msg/CompressedImage`.

- [ ] **Step 2: Launch the calibration app from the same sourced shell**

```bash
cd /home/mi/Calibration
npm run dev   # or however the app is launched in this project
```

The backend must inherit the ROS2 environment so `import rclpy` succeeds.

- [ ] **Step 3: Verify FisheyeTab end-to-end**

In the app:
1. Switch to the Fisheye tab.
2. Toggle Source to `ros2`. Confirm `/image_raw/compressed (1)` appears in the dropdown.
3. Pick the topic, click `live preview`. The raw cell renders the publisher's image.
4. Pick a dataset folder, press space, confirm a `snap_*.jpg` is written.
5. Run a calibration on a small set; confirm `K`, `D`, and the rectified preview render.
6. Toggle auto-capture; verify the rate slider appears. Drag from 0.5 s → 1.5 s; confirm the auto-snap cadence visibly slows.
7. Toggle Source back to `live`; confirm USB camera path still works (assuming a `/dev/video*` is connected).

- [ ] **Step 4: Verify IntrinsicsTab end-to-end**

Repeat steps 1–6 on the Pinhole tab. Confirm the slider and ros2 picker behave identically.

- [ ] **Step 5: Verify rclpy-missing error path**

Stop the backend, restart it in a shell **without** ROS2 sourced:

```bash
# Kill the existing backend, then:
unset AMENT_PREFIX_PATH ROS_DISTRO ROS_DOMAIN_ID PYTHONPATH
cd /home/mi/Calibration
npm run dev
```

In the app, switch a tab Source to `ros2`. The picker should display *"rclpy unavailable — source ROS2 setup before launching backend"*. The manual entry should still be visible (and using it would surface the same error in the rail status when an MJPEG / snap call fails).

- [ ] **Step 6: No commit needed for manual checks**

Capture findings in the PR description if you open one.

---

## Self-review

**Spec coverage**: every section of the spec maps to at least one task —
- Backend ImageSource protocol + `Ros2ImageSource` → Tasks 1, 2, 5
- `source_manager` polymorphic dispatch → Task 3
- `/stream/ros2_topics` endpoint + 503 handling → Task 4
- Client `listRos2Topics` → Task 6
- `Ros2TopicPicker` → Task 7
- FisheyeTab + IntrinsicsTab Source section + dead `bag` removal → Tasks 9, 10
- Auto-capture rate slider in `CaptureControls` and tab wiring → Tasks 8, 9, 10
- Lifecycle integration (`shutdown_all` calls `ros2_context.shutdown`) → Task 3
- Manual smoke-test plan → Task 11

**Placeholder scan**: no TBDs, no "implement appropriate handling," every code step has actual code, every test step has expected output.

**Type consistency**: `Ros2ImageSource.read()` returns `Optional[np.ndarray]` matching `CameraSource.read()`. The `info()` dict shape matches across both sources. The renderer uses `liveDevice = "ros2:" + topic` consistently in both tabs. `autoRate` units (seconds) are consistent across slider, label, and `onAutoMeta` (multiplied by 1000).
