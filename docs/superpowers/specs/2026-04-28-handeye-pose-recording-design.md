# Hand-Eye paired image+pose recording

**Status:** spec
**Date:** 2026-04-28

## Goal

In the Hand-Eye tab, capture a tracker pose alongside every camera image so the
dataset folder produced by a recording session is self-contained and feeds the
existing AX=XB solver without an out-of-band `poses.json`.

Two capture modes share the same per-image pairing logic:

- **Snap** — manual one-shot via the existing snap button.
- **Continuous (auto-rate)** — driven by the auto-capture rate slider already
  in `CaptureControls`. No new control surface.

## Non-goals

- ROS2 tracker recording. Only Oculus and SteamVR are wired this iteration
  (matches the existing `/poses/stream` source set).
- Reworking the solver. The existing `{basename → 4×4}` contract is preserved
  via a backward-compatible loader extension.
- Recording without a known dataset folder. The user picks a folder before
  recording, same as today.

## Architecture

The Hand-Eye tab grows a thin pose-stream client (reusing `/poses/stream`) and
a per-snap pose-tagging path. The image-snap codepath is unchanged; what
changes is that at the moment of capture the latest tracker pose is read off
the WS buffer and appended to a `poses.json` next to the images.

```
   Tracker source  ─┐
   (oculus/steamvr) │   /poses/stream WS  (ref-counted via pose_manager)
                    └─────────────────────┐
                                          ▼
   ┌────────────────┐     snap        ┌─────────────────┐
   │  Camera source │  ─────────────▶ │  HandEyeTab     │
   │  (live device) │   auto-snap     │  pose buffer    │
   └────────────────┘   timer         └────────┬────────┘
                                               │ per-image:
                                               │  • write image (existing /stream/snap)
                                               │  • append {basename: {T, ts}} to poses.json
                                               ▼
                                       dataset-folder/
                                         frame_001.png
                                         frame_002.png
                                         ...
                                         poses.json
                                         poses.meta.json
```

### Why a server-side `append_pose` endpoint

The renderer already POSTs the image via `/stream/snap`; making the pose
append symmetric (also through the API) keeps file I/O on one side, avoids a
renderer/Electron-fs branch, and lets the on-disk format change later without
touching the UI.

### Why `pose_manager`

`backend/app/sources/manager.py` already ref-counts camera sources so multiple
consumers (snap + MJPEG + WS) share one underlying capture. Pose sources today
do **not** have this — `routes.py:858` builds fresh `PoseSource` instances per
WS connection and closes them on disconnect. Two tabs that both want pose data
would open two SteamVR / Oculus clients and collide (SteamVR session, ADB
exclusivity, base-station handshake).

`pose_manager` is a small (~50 lines) mirror of `source_manager` — get / release
keyed by `(source_name, device_id)`, ref-counted, idle-tear-down. The
`/poses/stream` WS handler acquires from it on connect and releases on close.

## Components and state

### Renderer (`renderer/src/tabs/HandEyeTab.jsx`)

**New state:**

- `wsRef` — the `/poses/stream` WebSocket handle.
- `latestPoseRef` — `{ ts, T }` of the most recent pose for the selected
  device (kept in a ref so the snap closure always sees the current value
  without rebinding).
- `connected` — boolean, drives connect/disconnect button label and gates
  pose-tagging in snap.
- `autoCapture`, `autoCaptureHz` — wires the existing `CaptureControls` slider
  (today the prop is hardcoded `autoCapture={true}` with a no-op handler).
  When `autoCapture && connected`, a `setInterval` at `autoCaptureHz`
  triggers the same `onSnap` path.
- `recordedCount` — number of paired (image, pose) samples written this
  session.

**Reused, no-change:**

- The `/poses/stream` WS message shape: `{type:'sample', poses, wall_ts, ...}`.
- `CaptureControls` (auto-capture rate slider already there).
- `api.snap(device, dir)` for image writes.
- Existing `tracker_source`, `oculusDevice`, `steamvrSerial`, `kind`,
  `datasetPath`, `posesPath`, `cam` state.

The WS connection helper lives inline in the tab — only two callers (this and
LinkCalibTab) so factoring out a shared hook is premature.

### Backend

- `backend/app/sources/poses/manager.py` — new `pose_manager` (mirrors
  `source_manager`), get / release ref-counted.
- `backend/app/api/routes.py` — `/poses/stream` refactored to acquire/release
  via `pose_manager` instead of `_build_pose_source` direct.
- `backend/app/api/routes.py` — new `POST /handeye/append_pose`, body
  `{poses_path, basename, T, ts, meta?}`. Read-modify-atomic-write with
  `tmp = poses.json.tmp; json.dump(...); os.replace(tmp, poses.json)`.
  `meta` is only consumed on the first call of a session (when
  `poses.meta.json` does not yet exist) — it carries
  `{tracker_source, device, kind}`. The renderer sends it on every call;
  the backend ignores it after the meta file exists.
- `backend/app/calib/handeye.py` — extend `_load_poses_json` to accept both
  shapes (legacy `{basename: [[4x4]]}` and new `{basename: {T, ts}}`).

## Data flow per snap

1. Renderer reads `latestPoseRef.current` (`T`, `ts`).
2. Stale check: if `connected` and `now - ts > 200 ms`, block the snap; status:
   `"pose stale (Δt = … ms) — check tracker"`.
3. Renderer calls `api.snap(device, dir)` → backend writes `frame_NNN.png`,
   returns its path.
4. Renderer calls `api.appendHandeyePose({poses_path, basename, T, ts, meta})`
   with the pose snapshot taken at step 1 — read **before** the snap so time
   skew is bounded by image-write latency, not by network round-trip. `meta`
   carries `{tracker_source, device, kind}`; the backend uses it only on the
   first call of a session.
5. Backend atomically appends one entry to `poses.json`. On the **first**
   paired write of a session, the backend also writes `poses.meta.json`
   with `{tracker_source, device, kind, started_at, n}`. On subsequent writes
   it updates only `n` in `poses.meta.json` (read-modify-write, same
   atomic-rename pattern).
6. Renderer increments `recordedCount`, sets `posesPath` to
   `<dataset>/poses.json` if it wasn't already.

Continuous (auto-rate) recording is the same flow on a timer.

## File layout

```
session_2026-04-28/
  frame_001.png
  frame_002.png
  …
  poses.json           ← see below
  poses.meta.json      ← {tracker_source, device, kind, started_at, n}
```

`poses.json` value shape is polymorphic for back-compat:

```jsonc
// new, written by the recorder
{
  "frame_001.png": { "T": [[r,r,r,t],[r,r,r,t],[r,r,r,t],[0,0,0,1]],
                     "ts": 1735689600.123 }
}

// legacy, still accepted by the solver
{ "frame_001.png": [[4x4]] }
```

`poses.meta.json` is provenance only — the solver doesn't read it. It exists so
a re-loaded session knows which tracker / device produced it.

## UI surface

### Tracker source panel

- Add a `connect` / `disconnect` button row at the bottom of the panel
  (mirrors LinkCalibTab).
- While `connected`, disable: the source radio, the device picker for the
  selected source (oculus device, steamvr serial), and the `kind` `<select>`.
- Live readout below the buttons:
  `● <device> · <pose_rate_hz> Hz · <staleness_ms> ms` —
  green if pose seen within 200 ms, amber otherwise.

### Capture controls

- The auto-capture rate slider in `CaptureControls` is the continuous-record
  knob. No new control.
- Snap button label and behavior are unchanged. Internally it tags the pose
  when connected.

### Dataset panel

- After the first paired sample writes, append a `<KV>` row:
  `poses.json · N entries`.
- `posesPath` auto-fills to `<datasetPath>/poses.json`.

### Status line additions

- `connected · <source> · <device> · <fps> Hz`
- `recorded N (image+pose) · last <ms> ago`

The right-side results rail and the 3D scene are unchanged.

## Error handling

| Condition | Behavior |
|---|---|
| Snap pressed, not connected | Image saved, no pose entry; status `"snap (image only — connect tracker for pose)"` |
| Snap pressed, pose > 200 ms stale | Snap blocks; status `"pose stale (Δt = … ms) — check tracker"` |
| Snap succeeds, `append_pose` fails | Image is on disk; pose append retried once; if still fails, status `"image saved, pose append failed: <err>"`, entry dropped. Solver already tolerates images without matching poses. |
| Pose WS drops mid-recording | `recording=false`, `connected=false`, status `"tracker disconnected"`. Auto-capture timer stops. Existing entries intact on disk. |
| User clears dataset folder while connected | Dataset cleared, pose WS stays connected. Recording into a freshly-picked folder resumes. |
| Two tabs hold the pose stream | `pose_manager` ref-counts; same physical client serves both. |
| Switching `kind` while disconnected, poses already on disk | Allowed, but status warns if `poses.meta.json.kind` differs: `"poses.json has N <kind> entries — switching to <kind> will mix bodies"`. User clears or picks a new folder. |

## Testing

### Backend

- `pose_manager` ref-count get / release lifecycle (use the existing
  `source_manager` test as the template).
- `append_pose` atomicity: write + crash sim via mid-write `os.replace` mock —
  verify on-disk file is either the pre- or post-write state, never partial.
- `handeye._load_poses_json` accepts both legacy `[[4x4]]` and new
  `{T, ts}` shapes; rejects malformed input with a clear message.

### Renderer

- `HandEyeTab.test.jsx`:
  - snap-while-stale blocks (no `appendHandeyePose` call, no `snap` call).
  - snap-while-disconnected writes image-only (snap called, no
    `appendHandeyePose`).
  - snap-while-fresh produces an `appendHandeyePose` call with the
    expected basename and 4×4 matrix.

### Integration (manual)

- Mock pose source + auto-capture at 2 Hz for 10 s → 20 image+pose pairs in
  the dataset folder.
- Solve runs end-to-end without manual `posesPath` selection.

## Risks and open questions

- **Pose staleness threshold (200 ms)** is a guess. If the stream is at
  30 Hz the worst-case freshness is ~33 ms; a 200 ms threshold leaves headroom
  for transient hiccups without letting truly stale poses through. Revisit if
  field data shows it's wrong in either direction.
- **`pose_manager` is a real refactor**, not just a new file —
  `/poses/stream` has to switch to it. Tests for that handler should pass
  before HandEye starts using the stream.
- **Concurrency on `poses.json`** — two clients writing to the same dataset
  folder simultaneously would race. Acceptable: a session has one writer.
