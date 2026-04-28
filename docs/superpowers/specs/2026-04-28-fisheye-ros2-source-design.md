# Fisheye + Pinhole ROS2 image source — design

Adds a "ROS2 topic" source to the intrinsics tabs (Fisheye, Pinhole), so
the user can calibrate against a live `sensor_msgs/msg/CompressedImage`
publisher with the same flow they already have for USB cameras (live
preview, snap, auto-capture, rectified preview).

The change also bundles in an auto-capture rate slider that exposes the
previously hard-coded 500 ms debounce as a user control.

## Goals

- Add a ROS2-topic source mode to the FisheyeTab and IntrinsicsTab Source
  sections, sitting alongside the existing live-USB mode.
- Reuse every downstream feature unchanged: streamInfo poll, MJPEG live
  preview, rectified live preview, snap, auto-capture, snap-pair.
- Keep the backend's source abstraction polymorphic so future tabs
  (Extrinsics, Hand-Eye) can pick up ROS2 support without rework.
- Replace the hard-coded auto-capture debounce with a slider in
  `CaptureControls`.

## Non-goals

- ROS2 bag / MCAP file replay as an image source. The current `bag` UI
  stub is being removed; offline MCAP work stays in the Link tab's
  recording flow.
- Live streaming of `sensor_msgs/msg/Image` (uncompressed). Only
  `CompressedImage` is supported in this iteration.
- A UI for `ROS_DOMAIN_ID` / `RMW_IMPLEMENTATION` / QoS overrides — the
  backend inherits them from the launching shell; QoS is fixed at
  `qos_profile_sensor_data`.
- Other tabs (Extrinsics, HandEye, Chain, Link). Backend is generic to
  enable them later; this change touches only the two intrinsics tabs.
- Frontend unit tests — the project has no renderer test harness today,
  and adding one for a single component isn't justified. A manual smoke
  test plan covers the new flow.

## Architecture

```
            ┌──────────────────────────────┐
            │ FisheyeTab / IntrinsicsTab   │
            │   Source: [ live │ ros2 ]    │
            │      ┌────────────┐          │
            │      │ Ros2Topic  │          │
            │      │ Picker     │          │
            │      └────────────┘          │
            └────┬────────────────┬────────┘
                 │ liveDevice =   │
                 │  "ros2:/foo"   │
                 ▼                ▼
            ┌──────────────────────────────┐
            │ source_manager.get(key)      │
            │   key.startswith("ros2:")    │
            │     → Ros2ImageSource        │
            │   else                       │
            │     → CameraSource (today)   │
            └────┬─────────────────────────┘
                 │
                 ▼
            ┌──────────────────────────────┐
            │ ros2_context (singleton)     │
            │   rclpy.init() + Node +      │
            │   MultiThreadedExecutor      │
            │   on a daemon thread         │
            └──────────────────────────────┘
```

Every existing endpoint that takes a `device` string
(`/stream/info`, `/stream/mjpeg`, `/stream/mjpeg_rect`, `/stream/snap`,
`/stream/snap_pair`) becomes source-agnostic for free, because they only
call `source_manager.get(device)` and use the methods it returns.

One new endpoint exists for ROS2-topic discovery; topic listing is kept
separate from `/stream/devices` (USB) so the renderer doesn't have to
disambiguate transports at every call site.

## Backend

### `ImageSource` protocol

The methods `source_manager` already invokes today become an explicit
duck-typed contract. `CameraSource` already conforms; documenting it
clarifies the surface `Ros2ImageSource` must match.

- `start() -> None` — refcount-aware activate.
- `stop() -> None` — refcount-aware deactivate.
- `read() -> tuple[np.ndarray, float] | None` — latest BGR frame and a
  monotonic timestamp, or `None` if no frame has arrived yet.
- `info() -> dict` — `{open, width, height, capture_fps, fps_advertised,
  raw_width, raw_height, clipped}`. Fields not meaningful for ROS2
  (`fps_advertised`, `raw_width`, `raw_height`, `clipped`) report `None`
  / `False`.

No `ImageSource` ABC class is introduced; Python's structural typing is
sufficient and avoids forcing `CameraSource` to declare inheritance.

### `Ros2ImageSource(topic)` — `backend/app/sources/ros2.py` (new)

Owns one subscription on `sensor_msgs/msg/CompressedImage` against a
single topic.

- QoS: `rclpy.qos.qos_profile_sensor_data` (BEST_EFFORT, KEEP_LAST(1),
  VOLATILE) — what camera drivers publish with.
- Decode: `cv_bridge.CvBridge().compressed_imgmsg_to_cv2(msg, 'bgr8')`.
  cv_bridge is the standard ROS2 path; using it (instead of bare
  `cv2.imdecode`) leaves the door open for any other code that wants the
  conversion utility.
- Internal state: `_latest: tuple[np.ndarray, float] | None`,
  `_size: tuple[int,int] | None`, `_fps_meter: FpsMeter`, all guarded by
  `self._lock`. `_refs` for refcounted `start/stop`.
- `read()` returns the cached `(frame, ts)` (or `None`); never blocks on
  the executor thread.
- Decode failure: log once at WARNING, drop the message, keep last good
  frame. Same swallow-and-log shape `CameraSource` uses for I/O errors.

### `ros2_context` — `backend/app/sources/ros2_context.py` (new)

Process-wide singleton so we don't `rclpy.init()` per-source or build a
throwaway node for `list_topics`.

- `ensure_started() -> Node` — lazy on first call. Imports `rclpy`
  lazily so a backend without ROS2 sourced still boots; raises
  `RuntimeError("rclpy unavailable — source ROS2 setup before launching
  backend")` if the import fails. On success: `rclpy.init()`, create one
  `Node('calib_backend')`, build a `MultiThreadedExecutor`, spin it on a
  named daemon thread.
- `list_compressed_image_topics() -> list[dict]` — calls
  `node.get_topic_names_and_types()`, filters to
  `sensor_msgs/msg/CompressedImage`. For each topic, reports
  `{topic, n_publishers}` where `n_publishers = node.count_publishers(topic)`.
- `shutdown() -> None` — stop the executor, destroy the node, call
  `rclpy.shutdown()`. Wired into the existing FastAPI shutdown hook
  alongside `source_manager.shutdown_all()`.

### `source_manager.py` — patch

- `get(key)`: if `key.startswith("ros2:")` instantiate
  `Ros2ImageSource(key[len("ros2:"):])`, else `CameraSource(key)` as
  today. The `_sources` dict is already string-keyed; no schema change.
- `list_devices()` stays USB-only (it scans `/dev/video*`). ROS2 topic
  listing is a separate endpoint.
- `shutdown_all()`: after closing per-source refs, call
  `ros2_context.shutdown()` if it was ever started.

### API surface

One new endpoint:

- `GET /stream/ros2_topics` → `{topics: [{topic, n_publishers}, ...]}`.
  503 with a one-line hint if `ensure_started()` raises (rclpy not
  importable).

Unchanged endpoints (work transparently because they go through
`source_manager.get(device)`):

- `GET /stream/info?device=…`
- `GET /stream/mjpeg?device=…`
- `GET /stream/mjpeg_rect?device=…`
- `POST /stream/snap`
- `POST /stream/snap_pair`

The renderer always passes the manager-key string in `device`; the
prefix dispatch is invisible to the caller.

### Client (`renderer/src/api/client.js`)

Add one method:

```js
listRos2Topics: () => request('/stream/ros2_topics'),
```

No changes to `mjpegUrl`, `rectifiedMjpegUrl`, `streamInfo`, `snap`, or
`streamWsUrl`: they pass `device` through, and `liveDevice = "ros2:" + topic`
flows correctly end-to-end.

## Frontend

### `Ros2TopicPicker.jsx` (new shared component)

`renderer/src/components/Ros2TopicPicker.jsx`. Drop-in replacement for
the device dropdown when source mode is `ros2`. Keeps the picker code
out of two near-duplicate tab files.

Props: `topic, onTopic, status, onStatus`.

Behavior:

- On mount and on rescan, calls `api.listRos2Topics()`.
- Renders a `<select>` of discovered topics, formatted `topic (n)`
  where `n = n_publishers`.
- "↻ rescan" button refetches.
- Manual-entry row: free-text `<input>` + "use" button. Always visible
  (even when discovery succeeds), so users can type a not-yet-published
  topic and start the subscription before the publisher is up.
- 503 from `/stream/ros2_topics` → renders an inline error: *"rclpy
  unavailable — source ROS2 setup before launching backend"*. Manual
  entry still works.
- Empty list (rclpy fine, but no `CompressedImage` publishers found) →
  renders *"no CompressedImage topics found"*. Manual entry still works.

### `FisheyeTab.jsx` and `IntrinsicsTab.jsx` — patches

Both tabs receive the same Source-section change. Their existing tabs
are deliberate parallel files in this codebase, so the change is
duplicated; only the new ROS2-specific UI is shared via
`Ros2TopicPicker`.

State per tab:

- Replace `const [live, setLive] = useState(true)` with
  `const [sourceMode, setSourceMode] = useState('live')`. Values:
  `'live' | 'ros2'`.
- Add `const [ros2Topic, setRos2Topic] = useState('')`.
- The `live` flag previously passed to `CaptureControls` becomes
  literal `true` (auto-capture cares about a stream existing, not
  about the transport). The `live` / `onLive` props on
  `CaptureControls` are dropped together with the dead `bag` toggle.

Source section body:

- Seg: `[live | ros2]`. On change: set `sourceMode`, reset
  `liveDevice` to `''`, reset `ros2Topic` to `''` (clear stale state
  from the other transport).
- `sourceMode === 'live'` → existing UI (device `<select>`,
  streamInfo readout in Fisheye, "live preview" + "rescan" buttons).
  Unchanged from today.
- `sourceMode === 'ros2'` →
  `<Ros2TopicPicker topic={ros2Topic} onTopic={t => { setRos2Topic(t); setLiveDevice('ros2:' + t); }}/>`,
  followed by the same streamInfo readout (Fisheye only) and "live
  preview" button.
- Section `hint`:
  `sourceMode === 'live' ? (streamInfo?.open ? '<wxh · fps>' : (liveDevice || 'no device')) : (ros2Topic || 'no topic')`.

Toggling source mode is otherwise passive — no auto-prompt, no
auto-folder pick, matching the current `live`/`bag` toggle behavior.

The source-mode default is **not** persisted; each session starts on
`live`.

The dead `bag` UI block is removed from both tabs (and from the unused
`SourcePanel` in `panels.jsx`, which is no longer referenced).

### Auto-capture rate slider

Today: 500 ms hard-coded debounce in `onAutoMeta` in both intrinsics
tabs.

Change: surface the rate as a user control inside `CaptureControls`,
directly under the auto-capture checkbox row.

- New props on `CaptureControls`: `autoRate, onAutoRate`.
- New tab state: `const [autoRate, setAutoRate] = useState(0.5)` —
  seconds between snaps. Range: 0.2 s – 3.0 s, step 0.1 s. Default
  preserves today's behavior.
- The slider only renders when `autoCapture` is on (collapsed when
  off, no clutter).
- Layout reuses the existing `slider-row` style (matches `balance`,
  `fov scale`). Label format: `auto rate · 0.5s (≈2 fps)` — readable
  inverse-of-period live readout next to the value.
- Wiring in `onAutoMeta`:
  `if (now - lastAutoSnapRef.current < autoRate * 1000) return;`
  `autoRate` joins the `useCallback` dep list.

The slider state is owned by the tab (not internal to
`CaptureControls`) because `onAutoMeta` reads it through closure;
keeping the source of truth where the consumer is avoids prop-drilling
and ref dance.

## Lifecycle and edge cases

- **rclpy missing at runtime**: `/stream/ros2_topics` returns 503;
  `Ros2TopicPicker` shows the inline hint. Selecting any
  `liveDevice = 'ros2:<topic>'` after that hits the same lazy import
  error in `source_manager.get`, which surfaces in the rail status as a
  snap / streamInfo failure.
- **No publisher on the topic yet**: subscription created;
  `Ros2ImageSource.read()` returns `None` until first frame.
  `LivePreview` already renders an empty cell. snap fails with
  "no frame yet".
- **Publisher disappears mid-session**: last cached frame remains;
  `capture_fps` decays to 0 in the `FpsMeter` window. UI shows the
  stale frame with stale fps. Same UX as a USB camera unplug.
- **Decode failure (corrupt CompressedImage)**: callback logs once,
  drops the message, keeps last good frame.
- **Switching `liveDevice` between transports**: the existing
  refcounted `source_manager` keeps the old source alive until its
  consumers drop their refs (LivePreview's MJPEG, streamInfo poll),
  then closes it. New source starts fresh on the next `get(key)`.
  No special teardown in the tabs.
- **Snap-pair (Extrinsics, future)**: works for any combination
  (USB+USB, USB+ROS2, ROS2+ROS2) because the handler resolves both
  through `source_manager.get`.
- **Process shutdown**: `app.lifespan` calls
  `source_manager.shutdown_all()`, which now also calls
  `ros2_context.shutdown()` if it was ever started.

## Testing

Backend (pytest):

- `tests/sources/test_manager_dispatch.py` — `manager.get("/dev/video0")`
  returns a `CameraSource` instance, `manager.get("ros2:/foo")` returns
  a `Ros2ImageSource` instance, both refcounted. `rclpy` mocked at
  module level so the test runs without a ROS2 install.
- `tests/sources/test_ros2_source.py` — spins up a real `rclpy` node
  publishing a known JPEG payload to a CompressedImage topic, asserts
  `Ros2ImageSource.read()` returns a decoded BGR frame whose shape
  matches the expected width/height. Skipped via
  `pytest.importorskip("rclpy")` so CI without ROS2 stays green.
- `tests/api/test_ros2_topics_endpoint.py` — happy path with `rclpy`
  mocked (returns two topics, one matching the type filter, one not),
  and 503 path when `ensure_started()` raises.

Frontend: no new unit tests. Manual smoke test plan, executed once
before merge:

1. With ROS2 sourced, run
   `ros2 run image_publisher image_publisher_node <a>.jpg`
   to publish on `/image_raw/compressed`.
2. In FisheyeTab, switch Source toggle to `ros2`. Confirm the topic
   appears in the dropdown with publisher count 1.
3. Click "live preview" — confirm raw cell renders the live MJPEG.
4. Pick a dataset folder; press space — confirm snap writes a JPEG
   that opens correctly.
5. Run a calibration on a small set; confirm `K`, `D`, and rectified
   live preview all render.
6. Toggle auto-capture; verify the rate slider appears, drag it from
   0.5 s to 1.5 s, confirm the auto-snap cadence visibly slows.
7. Repeat steps 2–4 in IntrinsicsTab to confirm both tabs work.
8. Stop the publisher; confirm UI shows last frame and fps decays;
   restart it and confirm stream resumes.
9. Switch source toggle back to `live` mid-session; confirm USB
   camera path still works.

## Out-of-scope follow-ups

- ROS2 source for Extrinsics, HandEye, Chain, Link tabs. Backend is
  ready; UI patterns match this spec.
- `sensor_msgs/msg/Image` (uncompressed) support.
- Multi-topic sync (e.g., stereo) over ROS2 — would require a paired
  source class.
- ROS_DOMAIN_ID / RMW selector in the UI.
- Persisting source mode across sessions.
