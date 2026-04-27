# Topbar telemetry implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three hardcoded Topbar pills (`cam0 30.1 fps`, `SteamVR · 2 bases`, `tracker·3 drop 0.2%`) with live values driven by whatever streams the active tab is already running.

**Architecture:** Renderer-side React context (`TelemetryProvider`) holds per-camera FPS and per-device pose drop stats. Existing preview/stream consumers push their already-known stats via hooks; the Topbar reads the context and renders pills dynamically. One small backend change exposes the SteamVR base-station count in the `/poses/stream` hello envelope.

**Tech Stack:** React 18 (renderer), FastAPI/uvicorn (backend), pytest (backend test).

**Spec:** `docs/superpowers/specs/2026-04-27-topbar-telemetry-design.md`

---

## File Structure

| File | Role |
| --- | --- |
| `backend/app/sources/poses/mock.py` | Add `bases: 0` to `hello()` |
| `backend/app/sources/poses/oculus.py` | Add `bases: 0` to `hello()` |
| `backend/app/sources/poses/steamvr.py` | Count `tracking_reference` devices; add `bases: <int>` to `hello()` |
| `backend/app/api/routes.py` | Forward `bases` in merged hello envelope |
| `backend/tests/test_pose_hello.py` (new) | Pytest coverage for mock + steamvr `hello()` |
| `renderer/src/lib/telemetry.jsx` (new) | `TelemetryProvider`, `useReportCamera`, `useReportPoses`, `useTelemetry` |
| `renderer/src/App.jsx` | Wrap children with `<TelemetryProvider>` |
| `renderer/src/components/Topbar.jsx` | Replace mock pills with dynamic rendering |
| `renderer/src/components/LivePreview.jsx` | Call `useReportCamera` |
| `renderer/src/components/LiveDetectedFrame.jsx` | Call `useReportCamera` |
| `renderer/src/tabs/LinkCalibTab.jsx` | Track per-device drop, call `useReportPoses` |

---

### Task 1: Add `bases` field to mock and oculus pose sources

Both sources never see base stations; they get `bases: 0` so the Topbar's
field access is always defined.

**Files:**
- Modify: `backend/app/sources/poses/mock.py:52-53`
- Modify: `backend/app/sources/poses/oculus.py:49-50`
- Create: `backend/tests/__init__.py` (empty)
- Create: `backend/tests/test_pose_hello.py`

- [ ] **Step 1: Write the failing test for mock**

Create `backend/tests/__init__.py` as an empty file.

Create `backend/tests/test_pose_hello.py`:

```python
"""Unit tests for PoseSource.hello() envelopes — verifies the `bases` field
that the Topbar's SteamVR pill depends on is always present."""
from __future__ import annotations

from app.sources.poses.mock import MockPoseSource


def test_mock_hello_includes_bases_zero():
    src = MockPoseSource()
    h = src.hello()
    assert h["bases"] == 0
    assert "devices" in h
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/mi/Calibration/backend && .venv/bin/python -m pytest tests/test_pose_hello.py::test_mock_hello_includes_bases_zero -v
```

Expected: FAIL — `KeyError: 'bases'` (the field is not yet emitted).

- [ ] **Step 3: Add `bases: 0` to mock.py's `hello()`**

Replace lines 52-53 of `backend/app/sources/poses/mock.py`:

```python
    def hello(self) -> dict:
        return {"devices": list(DEVICES), "gt_T_a_b": self._gt.tolist(), "bases": 0}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/mi/Calibration/backend && .venv/bin/python -m pytest tests/test_pose_hello.py::test_mock_hello_includes_bases_zero -v
```

Expected: PASS.

- [ ] **Step 5: Mirror the same change in oculus.py**

Replace lines 49-50 of `backend/app/sources/poses/oculus.py`:

```python
    def hello(self) -> dict:
        return {"devices": list(DEVICES), "gt_T_a_b": None, "bases": 0}
```

(No automated test — instantiating `OculusPoseSource` requires real ADB/device.)

- [ ] **Step 6: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/sources/poses/mock.py backend/app/sources/poses/oculus.py backend/tests/__init__.py backend/tests/test_pose_hello.py && git commit -m "feat(pose): add bases field to mock/oculus hello envelopes"
```

---

### Task 2: Count `tracking_reference` devices in steamvr.py and expose `bases`

`SteamVRPoseSource.__init__` currently filters base stations out of
`self._devices`. Capture the count separately so `hello()` can return it.

**Files:**
- Modify: `backend/app/sources/poses/steamvr.py:40-51`
- Modify: `backend/tests/test_pose_hello.py` (add new test)

- [ ] **Step 1: Write the failing test for steamvr**

Append to `backend/tests/test_pose_hello.py`:

```python
import sys
import types

import pytest


class _FakeOpenVR:
    """Stand-in for the triad-openvr module so steamvr.py can be tested
    without a real SteamVR runtime. Mirrors the small surface that
    SteamVRPoseSource.__init__ touches: a `triad_openvr` callable that
    returns an object with a `.devices` dict mapping name -> device stub."""

    def __init__(self, device_names):
        self._device_names = device_names

    def triad_openvr(self):
        ns = types.SimpleNamespace()
        ns.devices = {name: object() for name in self._device_names}
        return ns


@pytest.fixture
def fake_triad(monkeypatch):
    """Install a fake `triad_openvr` module into sys.modules with the
    requested device list. Yields the install function; tests call it
    with the names they want."""
    def _install(names):
        fake = _FakeOpenVR(names)
        monkeypatch.setitem(sys.modules, "triad_openvr", fake)
        return fake
    return _install


def test_steamvr_hello_counts_tracking_references(fake_triad):
    fake_triad([
        "tracking_reference_1", "tracking_reference_2",
        "tracker_1", "controller_1",
    ])
    from app.sources.poses.steamvr import SteamVRPoseSource
    src = SteamVRPoseSource()
    h = src.hello()
    assert h["bases"] == 2
    assert "tracking_reference_1" not in h["devices"]
    assert "tracker_1" in h["devices"]


def test_steamvr_hello_zero_bases(fake_triad):
    fake_triad(["tracker_1"])
    from app.sources.poses.steamvr import SteamVRPoseSource
    src = SteamVRPoseSource()
    h = src.hello()
    assert h["bases"] == 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/mi/Calibration/backend && .venv/bin/python -m pytest tests/test_pose_hello.py -v
```

Expected: the two new `test_steamvr_*` tests FAIL — either with `KeyError: 'bases'` or because the source raises (no devices visible after filtering).

- [ ] **Step 3: Update steamvr.py to count bases and expose them**

Replace lines 40-51 of `backend/app/sources/poses/steamvr.py` (the existing two-line `# Snapshot the tracked set...` comment plus the device list / log / hello block) with:

```python
        # Snapshot the tracked set at connect time. Tracking-reference entries
        # are base stations — stationary by design, so not useful for the Link
        # tab — but the count is surfaced via hello() so the Topbar's SteamVR
        # pill can show "N bases".
        all_names = list(self._ov.devices)
        self._bases = sum(1 for n in all_names if n.startswith("tracking_reference"))
        self._devices = sorted(
            name for name in all_names
            if not name.startswith("tracking_reference")
        )
        if not self._devices:
            raise RuntimeError("SteamVR initialized but no tracked devices visible")
        log.info(
            "SteamVR: %d device(s) — %s · %d base(s)",
            len(self._devices), self._devices, self._bases,
        )

    def hello(self) -> dict:
        return {"devices": list(self._devices), "gt_T_a_b": None, "bases": self._bases}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && .venv/bin/python -m pytest tests/test_pose_hello.py -v
```

Expected: all four tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/sources/poses/steamvr.py backend/tests/test_pose_hello.py && git commit -m "feat(steamvr): expose base-station count in hello envelope"
```

---

### Task 3: Forward `bases` in `/poses/stream` merged hello

The route already merges hello envelopes from multiple sources (devices,
gt_T_a_b). Add a max-across-sources merge for `bases` so steamvr's count
flows to the renderer regardless of source ordering.

**Files:**
- Modify: `backend/app/api/routes.py:524-544`

- [ ] **Step 1: Update the merge loop and outgoing message**

In `backend/app/api/routes.py`, replace lines 524-544 with:

```python
        # Merge hello envelopes: union of device lists (ordered by source),
        # first non-null gt_T_a_b wins (mock is the only source that sets it),
        # max bases wins (only steamvr sets non-zero).
        all_devices: list[str] = []
        seen: set[str] = set()
        gt_link = None
        bases = 0
        for _name, src in built:
            h = src.hello()
            for d in h.get("devices") or []:
                if d not in seen:
                    seen.add(d)
                    all_devices.append(d)
            if gt_link is None and h.get("gt_T_a_b") is not None:
                gt_link = h["gt_T_a_b"]
            bases = max(bases, int(h.get("bases") or 0))

        await ws.send_text(json.dumps({
            "type": "hello",
            "sources": names,
            "fps": int(fps),
            "devices": all_devices,
            "gt_T_a_b": gt_link,
            "bases": bases,
        }))
```

- [ ] **Step 2: Smoke-test the route in the running backend**

Start the backend (`cd /home/mi/Calibration/backend && .venv/bin/python -m uvicorn app.main:app --port 8765`). In another shell:

```bash
python3 -c "
import asyncio, json, websockets
async def go():
    async with websockets.connect('ws://127.0.0.1:8765/poses/stream?sources=mock&fps=5') as ws:
        msg = json.loads(await ws.recv())
        print(msg)
        assert msg['type'] == 'hello' and msg['bases'] == 0, msg
asyncio.run(go())
"
```

Expected: prints a hello dict containing `'bases': 0`.

(The `websockets` module is in the dev venv via uvicorn's `[standard]` extra.)

- [ ] **Step 3: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/api/routes.py && git commit -m "feat(api): forward base-station count in merged poses hello"
```

---

### Task 4: Create `TelemetryProvider` context + hooks

Single file, no external deps beyond React. Internal throttling keeps
re-renders to ~2 Hz; a 1 Hz janitor drops stale entries.

**Files:**
- Create: `renderer/src/lib/telemetry.jsx`

- [ ] **Step 1: Write the file**

Create `renderer/src/lib/telemetry.jsx`:

```jsx
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// Update throttle for writer hooks. Each hook coalesces incoming reports
// to at most one state update every THROTTLE_MS so the topbar doesn't
// re-render on every camera frame.
const THROTTLE_MS = 500;

// Entries older than STALE_MS are dropped by the janitor — backstop for
// tabs that fail to clean up on unmount (errors, dropped WS without close).
const STALE_MS = 3000;

// Janitor sweep interval.
const JANITOR_MS = 1000;

const TelemetryCtx = createContext(null);

export function TelemetryProvider({ children }) {
  // cameras: { [device]: { fps, target, ts } }
  // poses:   { source: string[], bases: number, perDevice: { [name]: { dropPct, ts } }, ts } | null
  const [cameras, setCameras] = useState({});
  const [poses, setPoses] = useState(null);

  // Mutable refs accessed by writer callbacks without re-binding.
  const camerasRef = useRef(cameras);
  const posesRef = useRef(poses);
  useEffect(() => { camerasRef.current = cameras; }, [cameras]);
  useEffect(() => { posesRef.current = poses; }, [poses]);

  const reportCamera = useCallback((device, fps, target) => {
    if (!device) return;
    const prev = camerasRef.current[device];
    const now = performance.now();
    if (prev && now - prev.ts < THROTTLE_MS && prev.fps === fps && prev.target === target) return;
    setCameras(c => ({ ...c, [device]: { fps, target, ts: now } }));
  }, []);

  const clearCamera = useCallback((device) => {
    if (!device) return;
    setCameras(c => {
      if (!(device in c)) return c;
      const { [device]: _gone, ...rest } = c;
      return rest;
    });
  }, []);

  const reportPoses = useCallback((stats) => {
    if (stats == null) { setPoses(null); return; }
    const now = performance.now();
    const prev = posesRef.current;
    if (prev && now - prev.ts < THROTTLE_MS) {
      // Replace contents without bumping ts; next call past the throttle
      // window will commit a fresh ts. Keeps reads fresh enough without
      // firing a render every tick.
    }
    setPoses({ ...stats, ts: now });
  }, []);

  // Janitor: drop stale entries. Runs at JANITOR_MS, so worst-case staleness
  // before clear is STALE_MS + JANITOR_MS.
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = performance.now() - STALE_MS;
      setCameras(c => {
        let changed = false;
        const next = {};
        for (const [k, v] of Object.entries(c)) {
          if (v.ts >= cutoff) next[k] = v;
          else changed = true;
        }
        return changed ? next : c;
      });
      setPoses(p => (p && p.ts < cutoff ? null : p));
    }, JANITOR_MS);
    return () => clearInterval(id);
  }, []);

  const value = { cameras, poses, reportCamera, clearCamera, reportPoses };
  return <TelemetryCtx.Provider value={value}>{children}</TelemetryCtx.Provider>;
}

export function useTelemetry() {
  const ctx = useContext(TelemetryCtx);
  if (!ctx) throw new Error('useTelemetry must be used inside <TelemetryProvider>');
  return ctx;
}

// Push a camera's current capture FPS into the context. Pass `fps == null`
// to leave the entry untouched (e.g. while the stream is still warming up);
// the entry is automatically cleared on unmount.
export function useReportCamera(device, fps, target) {
  const { reportCamera, clearCamera } = useTelemetry();
  useEffect(() => {
    if (device && fps != null && Number.isFinite(fps)) {
      reportCamera(device, fps, target);
    }
  }, [device, fps, target, reportCamera]);
  useEffect(() => {
    if (!device) return;
    return () => clearCamera(device);
  }, [device, clearCamera]);
}

// Push the latest pose-stream stats. Pass `null` to clear (e.g. on WS close).
export function useReportPoses(stats) {
  const { reportPoses } = useTelemetry();
  useEffect(() => {
    reportPoses(stats);
  }, [stats, reportPoses]);
  useEffect(() => () => reportPoses(null), [reportPoses]);
}
```

- [ ] **Step 2: Verify the file parses by starting Vite**

```bash
cd /home/mi/Calibration && npm run dev:vite
```

Expected: Vite starts without syntax errors. (No need to open the app yet — just confirm the new module compiles.) Stop with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/lib/telemetry.jsx && git commit -m "feat(renderer): add TelemetryProvider context for topbar pills"
```

---

### Task 5: Wrap `<App>` in `<TelemetryProvider>`

**Files:**
- Modify: `renderer/src/App.jsx:1-2,56-67`

- [ ] **Step 1: Add import**

Add this import at the top of `renderer/src/App.jsx` (after the existing React import on line 1):

```jsx
import { TelemetryProvider } from './lib/telemetry.jsx';
```

- [ ] **Step 2: Wrap the returned tree**

In `renderer/src/App.jsx`, replace the contents of the `return (...)` block (lines 56-67) with:

```jsx
  return (
    <TelemetryProvider>
      <div className="app">
        <Topbar mode={mode} onMode={setMode}/>
        <Tabs tabs={TAB_DEFS} value={active} onChange={setActive}/>
        <ActiveComp/>
        <LogStrip lines={[
          active === 'intrinsics' ? 'solver: LM converged in 24 iters · Δcost 7.2e-7' : 'joint bundle adjustment · 132 constraints active',
          active === 'fisheye' ? 'fisheye/equidistant · k₁…k₄ estimated · ω 195.3°' : 'T_ctrl_cam saved to session_0419.toml [calib.hand_eye]'
        ]}/>
        <TweaksPanel visible={tweaksVisible} tweaks={tweaks} setTweaks={setTweaks} onClose={() => setTweaksVisible(false)}/>
      </div>
    </TelemetryProvider>
  );
}
```

- [ ] **Step 3: Verify the app still loads**

```bash
cd /home/mi/Calibration && npm run dev:vite
```

Open the app (or the Vite URL it prints). Expected: app renders, Topbar still shows the (still-mock) pills — no console errors. Stop Vite.

- [ ] **Step 4: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/App.jsx && git commit -m "feat(renderer): wrap App in TelemetryProvider"
```

---

### Task 6: Replace mock pills in Topbar with dynamic rendering

**Files:**
- Modify: `renderer/src/components/Topbar.jsx`

- [ ] **Step 1: Rewrite Topbar.jsx**

Replace the entire contents of `renderer/src/components/Topbar.jsx` with:

```jsx
import React from 'react';
import { Pill } from './primitives.jsx';
import { useTelemetry } from '../lib/telemetry.jsx';

// Map a /dev/videoN path to a short label. Anything else falls through.
function camLabel(device) {
  const m = /^\/dev\/video(\d+)$/.exec(device);
  return m ? `cam${m[1]}` : device;
}

function fpsStatus(fps, target) {
  if (fps == null || !Number.isFinite(fps) || fps <= 0) return 'bad';
  if (target && fps >= target * 0.85) return 'ok';
  if (target && fps >= target * 0.5)  return 'warn';
  return 'bad';
}

function basesStatus(bases) {
  if (bases >= 2) return 'ok';
  if (bases === 1) return 'warn';
  return 'bad';
}

function dropStatus(pct) {
  if (pct < 1) return 'ok';
  if (pct <= 5) return 'warn';
  return 'bad';
}

export function Topbar({ mode, onMode }) {
  const { cameras, poses } = useTelemetry();

  const camPills = Object.entries(cameras)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([device, { fps, target }]) => (
      <Pill key={`cam:${device}`} status={fpsStatus(fps, target)}>
        {camLabel(device)} {fps != null ? fps.toFixed(1) : '—'} fps
      </Pill>
    ));

  const showSteamVR = poses && Array.isArray(poses.source) && poses.source.includes('steamvr');
  const steamPill = showSteamVR ? (
    <Pill key="steamvr" status={basesStatus(poses.bases ?? 0)}>
      SteamVR · {poses.bases ?? 0} bases
    </Pill>
  ) : null;

  const dropPills = poses && poses.perDevice
    ? Object.entries(poses.perDevice)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { dropPct }]) => (
          <Pill key={`drop:${name}`} status={dropStatus(dropPct)}>
            {name} drop {dropPct.toFixed(1)}%
          </Pill>
        ))
    : [];

  return (
    <div className="topbar">
      <span className="brand"><span className="brand-mark"/>Calibration Workbench</span>
      <span className="divider"/>
      <div className="session">
        {camPills}
        {steamPill}
        {dropPills}
      </div>
      <span className="divider"/>
      <span className="session"><span className="path">~/projects/vr_rig/calib/session_0419.toml</span></span>
      <span className="spacer"/>
      <div className="mode-toggle">
        <button className={mode === 'live' ? 'on' : ''} onClick={() => onMode('live')}>live</button>
        <button className={mode === 'bag' ? 'on' : ''} onClick={() => onMode('bag')}>bag</button>
      </div>
      <button className="btn">↓ import yaml</button>
      <button className="btn">↑ export bundle</button>
      <button className="btn ghost icon" title="settings">⚙</button>
    </div>
  );
}
```

- [ ] **Step 2: Verify the app loads with empty pill area**

```bash
cd /home/mi/Calibration && npm run dev:vite
```

Open the app and stay on a tab that doesn't open any camera (e.g. open Chain tab, or load before any tab opens cameras). Expected: the `.session` slot between the dividers is empty — no pill clutter, no console errors. Stop Vite.

- [ ] **Step 3: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/components/Topbar.jsx && git commit -m "feat(topbar): render pills from TelemetryProvider"
```

---

### Task 7: Wire camera FPS reporting from preview components

Two single-line additions. Both components already track `capFps` and a target.

**Files:**
- Modify: `renderer/src/components/LivePreview.jsx:1-2,36`
- Modify: `renderer/src/components/LiveDetectedFrame.jsx:1-2,23`

- [ ] **Step 1: Add hook call in `LivePreview.jsx`**

In `renderer/src/components/LivePreview.jsx`:

(a) Update the imports — replace line 2 with:

```jsx
import { api, mjpegUrl } from '../api/client.js';
import { useReportCamera } from '../lib/telemetry.jsx';
```

(b) Inside the `LivePreview` component body, the existing `useEffect` ends at line 23 with `}, [device, fps, quality]);`. The component then has *two* early returns (`if (!device) return …` at line 26 and `if (!url) return null;` at line 34) before `capFps` is computed. To stay legal under the rules of hooks, the new hook must come *before* those early returns.

Insert this line directly after the existing `useEffect` closing (i.e. on a new line between line 23 and the blank line 24):

```jsx
  useReportCamera(device, info?.capture_fps, fps);
```

(`info?.capture_fps` is `undefined` until the first poll lands; `useReportCamera` already no-ops on non-finite values, so the entry simply doesn't appear until real FPS data arrives.)

- [ ] **Step 2: Add hook call in `LiveDetectedFrame.jsx`**

In `renderer/src/components/LiveDetectedFrame.jsx`:

(a) Update the imports — replace line 2 with:

```jsx
import { streamWsUrl } from '../api/client.js';
import { useReportCamera } from '../lib/telemetry.jsx';
```

(b) Inside `LiveDetectedFrame`, immediately *after* the `const [capFps, setCapFps] = useState(null);` line (currently line 23), add:

```jsx
  useReportCamera(device, capFps, fps);
```

- [ ] **Step 3: Manual verify camera pills**

```bash
cd /home/mi/Calibration && npm run dev
```

(a) Open the **Intrinsics** tab and pick `/dev/video0`. Within ~2 s the topbar should show one pill `cam0 XX.X fps` with status `ok` (green) when capture is healthy.

(b) Switch to **Extrinsics** and pick two cameras (e.g. `/dev/video0` and `/dev/video2`). Topbar should show two pills (`cam0 …`, `cam2 …`) sorted by name.

(c) Switch back to a tab that opens no cameras — pills should disappear within ~3 s (janitor sweep).

(d) Stop the dev environment.

- [ ] **Step 4: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/components/LivePreview.jsx renderer/src/components/LiveDetectedFrame.jsx && git commit -m "feat(preview): report capture FPS to TelemetryProvider"
```

---

### Task 8: Wire pose-stream stats from `LinkCalibTab`

Track per-device "present in this tick" history in a 5 s ring; recompute drop%
every 500 ms; push the result via `useReportPoses`. Clear on disconnect.

**Files:**
- Modify: `renderer/src/tabs/LinkCalibTab.jsx`

- [ ] **Step 1: Update imports**

In `renderer/src/tabs/LinkCalibTab.jsx`, find the existing line 10:

```jsx
import { api, posesWsUrl, pickSaveFile, pickOpenFile } from '../api/client.js';
```

Add a new import line directly below it:

```jsx
import { useReportPoses } from '../lib/telemetry.jsx';
```

- [ ] **Step 2: Track hello metadata + per-device tick history**

Inside the `LinkCalibTab` component, near the other `useRef` declarations (around line 55, where `samplesRef` is defined), add three new refs and one piece of state:

```jsx
  // Telemetry state for the topbar pills. Refs so the WS onmessage closure
  // doesn't have to be rebuilt on every update; the React state is what we
  // hand to useReportPoses (so context updates flow normally).
  const helloRef    = useRef({ source: [], bases: 0, devices: [] });
  const ticksRef    = useRef({});                 // { [name]: Array<{ts, present}> }
  const [poseStats, setPoseStats] = useState(null);
  useReportPoses(poseStats);
```

- [ ] **Step 3: Capture hello details when WS opens**

In the existing `ws.onmessage` handler (around line 96-128 of the current file), inside the `if (m.type === 'hello') { ... }` block, *after* the existing `setStatus(...)` call but *before* the `return;`, add:

```jsx
          helloRef.current = {
            source: Array.isArray(m.sources) ? m.sources : (m.source ? [m.source] : []),
            bases: Number.isFinite(m.bases) ? m.bases : 0,
            devices: Array.isArray(m.devices) ? m.devices : [],
          };
          ticksRef.current = Object.fromEntries((m.devices ?? []).map(d => [d, []]));
```

- [ ] **Step 4: Record per-device presence on every sample**

In the same `ws.onmessage`, the `if (m.type !== 'sample') return;` path is currently:

```jsx
        if (m.type !== 'sample') return;
        // Sample collection gate — controlled by `streaming`. Read the ref so the
        // onmessage closure doesn't need to be rebuilt every time the flag flips.
        if (!collectingRef.current) return;
        const poses = m.poses || {};
        for (const [dev, T] of Object.entries(poses)) {
          ...
        }
```

The drop-rate telemetry has to update regardless of whether the user is
actively recording samples, so we read `m.poses` *before* the
`collectingRef` gate. Replace the block above with:

```jsx
        if (m.type !== 'sample') return;
        const samplePoses = m.poses || {};
        const nowMs = performance.now();
        const cutoffMs = nowMs - 5000;
        for (const dev of helloRef.current.devices) {
          const arr = ticksRef.current[dev] || (ticksRef.current[dev] = []);
          arr.push({ ts: nowMs, present: dev in samplePoses });
          // Trim the ring to the 5 s window.
          while (arr.length && arr[0].ts < cutoffMs) arr.shift();
        }
        // Sample collection gate — controlled by `streaming`. Read the ref so the
        // onmessage closure doesn't need to be rebuilt every time the flag flips.
        if (!collectingRef.current) return;
        const poses = samplePoses;
        for (const [dev, T] of Object.entries(poses)) {
```

(The `for (const [dev, T] of Object.entries(poses))` line and the lines
after it are unchanged from the original — the snippet above just shows
the new block leading into it.)

- [ ] **Step 5: Aggregate and publish stats every 500 ms**

Add a new `useEffect` near the other effects (e.g. just below the
`useEffect(() => () => disconnect(), [disconnect]);` line, around line 143):

```jsx
  // Recompute per-device drop% from the rolling 5 s window and push to the
  // TelemetryProvider so the topbar's SteamVR/tracker pills update. Cleared
  // when no WS is connected.
  useEffect(() => {
    if (!connected) {
      setPoseStats(null);
      return;
    }
    const id = setInterval(() => {
      const { source, bases, devices } = helloRef.current;
      const perDevice = {};
      for (const dev of devices) {
        const arr = ticksRef.current[dev] || [];
        if (arr.length === 0) {
          perDevice[dev] = { dropPct: 0 };
          continue;
        }
        const absent = arr.reduce((n, e) => n + (e.present ? 0 : 1), 0);
        perDevice[dev] = { dropPct: (absent / arr.length) * 100 };
      }
      setPoseStats({ source, bases, perDevice });
    }, 500);
    return () => clearInterval(id);
  }, [connected]);
```

- [ ] **Step 6: Clear stats on disconnect**

Find the existing `disconnect` callback (around line 134) and add a `setPoseStats(null)` line. Replace lines 134-137 with:

```jsx
  const disconnect = useCallback(() => {
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    setConnected(false); setStreaming(false);
    setPoseStats(null);
  }, []);
```

- [ ] **Step 7: Manual verify pose pills**

```bash
cd /home/mi/Calibration && npm run dev
```

(a) Open **Link** tab. Pick `mock` for both sources. Click connect. Within ~1 s the topbar should show two `*** drop 0.0%` pills (one per mock device — `tracker_0`, `controller_R`). **No** SteamVR pill (mock isn't steamvr).

(b) If SteamVR is available: change source A to `steamvr` and reconnect. Topbar should now show `SteamVR · N bases` (status reflects N) plus drop pills for each tracked device.

(c) Click disconnect. All pose pills clear within ~1 s.

(d) Stop the dev environment.

- [ ] **Step 8: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/tabs/LinkCalibTab.jsx && git commit -m "feat(link): report pose stream telemetry to topbar"
```

---

### Task 9: End-to-end manual verification

Walks the spec's manual test plan in one pass to confirm nothing regressed
across the full feature.

- [ ] **Step 1: Run the app**

```bash
cd /home/mi/Calibration && npm run dev
```

- [ ] **Step 2: Walk the test plan**

Confirm all six items from the spec's "Manual test plan" section
(`docs/superpowers/specs/2026-04-27-topbar-telemetry-design.md`):

1. Intrinsics tab → exactly one camera pill, FPS updates live.
2. Switch to Extrinsics → two camera pills (cam0, cam1) appear.
3. Switch to Link with `sources=mock` → no SteamVR pill, one drop pill per mock device.
4. Switch to Link with `sources=steamvr` → `SteamVR · N bases` pill plus per-device drop pills. *(Skip if no SteamVR hardware.)*
5. Stop a stream / leave a tab → corresponding pills disappear within ~3 s.
6. Kill SteamVR mid-stream → drop% climbs, status flips to `bad`. *(Skip if no SteamVR hardware.)*

For any failure, fix in the affected task's files and recommit (no new tasks needed unless something is fundamentally off).

- [ ] **Step 3: Stop the app**

Ctrl-C the dev server.
