# Link tab — unified two-slot sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Link tab's two separate sub-flows (live pair, vive+mcap) with one symmetric two-slot UI where each slot can be live (Oculus/SteamVR/mock) or imported (json/yaml/mcap), and the user maps device→device for the extrinsics solve.

**Architecture:** Both modes normalize to the same on-disk recording JSON shape `{meta, samples:[{ts,T}]}`. Live mode keeps the existing connect→record→save path. Import mode adds a new backend endpoint `/recording/import_file` that reads json or yaml and returns a canonical path; mcap continues using `/recording/import_mcap`. Both slots, once "ready" (path on disk + chosen device), feed the existing `/recording/sync` → `/calibrate/handeye_pose` pipeline. Frontend uses one WebSocket per live slot so the slots are fully decoupled.

**Tech Stack:** FastAPI + ruamel.yaml (backend), pytest + httpx TestClient (backend tests), React (renderer/src/tabs/LinkCalibTab.jsx), existing Section/Field/Seg/KV primitives.

**Spec:** `docs/superpowers/specs/2026-05-05-link-tab-unified-sources-design.md`

---

## File Structure

**Backend (modify):**
- `backend/app/api/routes.py` — add `recording_import_file` handler; extend `recording_sync` to accept `a_path`/`b_path` aliases; response gains `a_rot_deg`/`b_rot_deg` keys (mirrors of vive_/umi_).
- `backend/tests/test_recording_import_file.py` — **new** test file.
- `backend/tests/test_sync_endpoint.py` — **new** test file (covers `/recording/sync` route-level alias behaviour). The existing `test_sync.py` covers the pure `sync_streams` helper and is left alone.

**Frontend (modify):**
- `renderer/src/api/client.js` — add `recording.importFile`; rename keys in `recording.sync` to `a_path`/`b_path`.
- `renderer/src/tabs/LinkCalibTab.jsx` — major rewrite of the rail; viewport rendering reused.
- `renderer/src/tabs/_linkSlot.js` — **new** small module exporting `initialSlot`, `slotReady(s)`, and `useSlotWs(slot, setSlot, ...)` hook so the giant tab file is not the only place this state shape lives.

**Unchanged:**
- `backend/app/calib/sync.py`
- `backend/app/calib/handeye_pose.py`
- `renderer/src/components/scene3d.jsx` and viewport primitives.

---

## Task 1: Backend — `/recording/import_file` (json path)

**Files:**
- Create: `backend/tests/test_recording_import_file.py`
- Modify: `backend/app/api/routes.py` (add handler near the other `/recording/*` handlers, around line 884)

- [ ] **Step 1: Write the failing test for json round-trip**

Create `backend/tests/test_recording_import_file.py` with:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_recording_import_file.py::test_import_file_json_roundtrip -v`
Expected: FAIL with HTTP 404 / "Not Found" (route does not exist yet).

- [ ] **Step 3: Add the json branch of the handler**

In `backend/app/api/routes.py`, immediately after the existing `recording_list_topics` function (around line 911), add:

```python
@router.post("/recording/import_file")
async def recording_import_file(body: dict) -> dict:
    """Normalize a json or yaml pose recording into the canonical on-disk shape.

    Body: { path, format = "json" | "yaml" }.
    Returns { ok, path, count, t_first, t_last, device? }.
    """
    src_path = body.get("path")
    fmt = (body.get("format") or "").lower()
    if not src_path or not os.path.isfile(src_path):
        raise HTTPException(status_code=404, detail="path not found")
    if fmt not in ("json", "yaml"):
        raise HTTPException(status_code=400, detail=f"unknown format: {fmt!r}")

    try:
        if fmt == "json":
            with open(src_path) as f:
                data = json.load(f)
        else:
            from ruamel.yaml import YAML
            _y = YAML(typ="safe", pure=True)
            with open(src_path) as f:
                data = _y.load(f) or {}
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"read failed: {e}") from e

    if not isinstance(data, dict) or "samples" not in data:
        raise HTTPException(status_code=400, detail="invalid recording: missing 'samples'")
    samples = data["samples"]
    if not isinstance(samples, list) or not samples:
        raise HTTPException(status_code=400, detail="invalid recording: 'samples' must be non-empty list")
    for i, s in enumerate(samples):
        if not isinstance(s, dict) or "ts" not in s or "T" not in s:
            raise HTTPException(status_code=400, detail=f"sample[{i}] missing 'ts' or 'T'")
        if not isinstance(s["ts"], (int, float)):
            raise HTTPException(status_code=400, detail=f"sample[{i}].ts is not numeric")
        T = s["T"]
        if (not isinstance(T, list) or len(T) != 4
                or any(not isinstance(row, list) or len(row) != 4 for row in T)):
            raise HTTPException(status_code=400, detail=f"sample[{i}].T is not 4x4")

    meta = data.get("meta") or {}
    device = meta.get("device") if isinstance(meta, dict) else None
    t_first = float(samples[0]["ts"])
    t_last = float(samples[-1]["ts"])

    if fmt == "json":
        out_path = src_path
    else:
        # YAML inputs are normalized to a sibling .json so the rest of the pipeline
        # (sync, solve) reads JSON only — same approach the mcap importer uses.
        base, _ = os.path.splitext(src_path)
        out_path = base + ".normalized.json"
        out_doc = {
            "meta": {**meta, "kind": meta.get("kind") or "imported", "n": len(samples),
                     "t_first": t_first, "t_last": t_last},
            "samples": samples,
        }
        try:
            with open(out_path, "w") as f:
                json.dump(out_doc, f)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"write failed: {e}") from e

    return {
        "ok": True,
        "path": out_path,
        "count": len(samples),
        "t_first": t_first,
        "t_last": t_last,
        "device": device,
    }
```

- [ ] **Step 4: Run test to verify json case passes**

Run: `cd backend && python -m pytest tests/test_recording_import_file.py::test_import_file_json_roundtrip -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/routes.py backend/tests/test_recording_import_file.py
git commit -m "feat(api): add /recording/import_file (json path) for symmetric source loading"
```

---

## Task 2: Backend — `/recording/import_file` (yaml path + error cases)

**Files:**
- Modify: `backend/tests/test_recording_import_file.py`

- [ ] **Step 1: Add yaml + error-case tests**

Append to `backend/tests/test_recording_import_file.py`:

```python
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
```

- [ ] **Step 2: Run all tests in the new file**

Run: `cd backend && python -m pytest tests/test_recording_import_file.py -v`
Expected: all 5 tests PASS (the json roundtrip from Task 1 plus the 4 new ones).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_recording_import_file.py
git commit -m "test(api): yaml + error cases for /recording/import_file"
```

---

## Task 3: Backend — `/recording/sync` accepts `a_path`/`b_path` aliases

**Files:**
- Create: `backend/tests/test_sync_endpoint.py`
- Modify: `backend/app/api/routes.py` (the `recording_sync` handler around line 803)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_sync_endpoint.py`:

```python
"""Route-level tests for /recording/sync alias handling.

The pure sync_streams helper is exercised by tests/test_sync.py — this file only
checks the route accepts the new a_path/b_path keys identically to the legacy
vive_path/umi_path keys, and that the response carries the new a_rot_deg / b_rot_deg
mirrors of the existing vive_rot_deg / umi_rot_deg fields.
"""
from __future__ import annotations

import json
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _write_recording(path, *, t_start, n=300, dt=1 / 30):
    samples = []
    for i in range(n):
        t = t_start + i * dt
        ang = i * dt * 1.0
        c, s = math.cos(ang), math.sin(ang)
        T = np.eye(4)
        T[:3, :3] = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)
        T[:3, 3] = [c, s, 0.5 * math.sin(2 * ang)]
        samples.append({"ts": t, "T": T.tolist()})
    doc = {"meta": {"kind": "rec", "n": n, "t_first": samples[0]["ts"],
                     "t_last": samples[-1]["ts"]}, "samples": samples}
    with open(path, "w") as f:
        json.dump(doc, f)


def test_sync_accepts_a_path_b_path(client, tmp_path):
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    out = tmp_path / "synced.json"
    _write_recording(str(a), t_start=1000.0)
    _write_recording(str(b), t_start=1000.3)

    resp = client.post("/recording/sync", json={
        "a_path": str(a),
        "b_path": str(b),
        "out_path": str(out),
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["n_pairs"] >= 200
    # New fields mirror the legacy ones.
    assert "a_rot_deg" in body and "b_rot_deg" in body
    assert body["a_rot_deg"] == body["vive_rot_deg"]
    assert body["b_rot_deg"] == body["umi_rot_deg"]


def test_sync_legacy_vive_umi_keys_still_work(client, tmp_path):
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    out = tmp_path / "synced.json"
    _write_recording(str(a), t_start=2000.0)
    _write_recording(str(b), t_start=2000.0)

    resp = client.post("/recording/sync", json={
        "vive_path": str(a),
        "umi_path": str(b),
        "out_path": str(out),
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert "a_rot_deg" in body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_sync_endpoint.py -v`
Expected: `test_sync_accepts_a_path_b_path` FAILS with 404 ("vive_path not found") because the handler currently reads `vive_path` only.

- [ ] **Step 3: Update `recording_sync` to accept aliases**

In `backend/app/api/routes.py`, replace the body of `recording_sync` (currently lines ~803–860) with the alias-aware version. Find the existing function and replace it with:

```python
@router.post("/recording/sync")
async def recording_sync(body: dict) -> dict:
    """Sync two pose recordings into a paired-sample JSON.

    Body accepts new keys (a_path, b_path) or legacy keys (vive_path, umi_path).
    Response carries both naming conventions for back-compat.
    """
    from app.calib.sync import sync_streams

    a_path = body.get("a_path") or body.get("vive_path")
    b_path = body.get("b_path") or body.get("umi_path")
    out_path = body.get("out_path")
    if not (a_path and os.path.isfile(a_path)):
        raise HTTPException(status_code=404, detail="a_path not found")
    if not (b_path and os.path.isfile(b_path)):
        raise HTTPException(status_code=404, detail="b_path not found")
    if not out_path:
        raise HTTPException(status_code=400, detail="out_path required")

    max_skew_s = float(body.get("max_skew_s", 5.0))
    max_pair_gap_s = float(body.get("max_pair_gap_s", 0.05))

    with open(a_path) as f:
        a_data = json.load(f)
    with open(b_path) as f:
        b_data = json.load(f)

    res = sync_streams(
        a_data["samples"], b_data["samples"],
        max_skew_s=max_skew_s, max_pair_gap_s=max_pair_gap_s,
    )
    if not res["ok"]:
        raise HTTPException(status_code=400, detail=res.get("reason") or "sync failed")
    if res["n_pairs"] < 50:
        raise HTTPException(status_code=400, detail=f"only {res['n_pairs']} pairs after sync (need >= 50)")

    out = {
        "meta": {
            "kind": "synced",
            "n": res["n_pairs"],
            "delta_t": res["delta_t"],
            "a_rot_deg": res["vive_rot_deg"],
            "b_rot_deg": res["umi_rot_deg"],
        },
        "samples": res["pairs"],
    }
    try:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(out, f)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}") from e

    return {
        "ok": True,
        "n_pairs": res["n_pairs"],
        "delta_t": res["delta_t"],
        "snr": res.get("snr"),
        "vive_rot_deg": res["vive_rot_deg"],
        "umi_rot_deg": res["umi_rot_deg"],
        "a_rot_deg": res["vive_rot_deg"],
        "b_rot_deg": res["umi_rot_deg"],
        "path": out_path,
    }
```

- [ ] **Step 4: Run both alias tests**

Run: `cd backend && python -m pytest tests/test_sync_endpoint.py -v`
Expected: both PASS.

- [ ] **Step 5: Confirm legacy unit tests still pass**

Run: `cd backend && python -m pytest tests/test_sync.py tests/test_handeye_pose.py -v`
Expected: PASS (helper-level tests are unaffected by the route change).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/routes.py backend/tests/test_sync_endpoint.py
git commit -m "feat(api): /recording/sync accepts a_path/b_path; legacy aliases preserved"
```

---

## Task 4: Frontend — `recording.importFile` client + sync key rename

**Files:**
- Modify: `renderer/src/api/client.js` (the `recording` export around lines 111–122)

- [ ] **Step 1: Add `importFile` and rename sync params**

In `renderer/src/api/client.js`, replace the `recording` export with:

```javascript
export const recording = {
  save: ({ kind, samples, path }) =>
    request('/recording/save', { method: 'POST', body: JSON.stringify({ kind, samples, path }) }),
  listTopics: (mcap_path) =>
    request(`/recording/list_topics?mcap_path=${encodeURIComponent(mcap_path)}`),
  importMcap: ({ mcap_path, topic, out_path }) =>
    request('/recording/import_mcap', { method: 'POST', body: JSON.stringify({ mcap_path, topic, out_path }) }),
  importFile: ({ path, format }) =>
    request('/recording/import_file', { method: 'POST', body: JSON.stringify({ path, format }) }),
  sync: ({ a_path, b_path, out_path, max_skew_s, max_pair_gap_s }) =>
    request('/recording/sync', { method: 'POST', body: JSON.stringify({ a_path, b_path, out_path, max_skew_s, max_pair_gap_s }) }),
  calibrateHandeyePose: ({ synced_path, method }) =>
    request('/calibrate/handeye_pose', { method: 'POST', body: JSON.stringify({ synced_path, method }) }),
};
```

- [ ] **Step 2: Sanity-check the frontend builds**

Run: `cd /home/mi/Calibration && npm run build --workspace=renderer 2>&1 | tail -20` (or whatever the project's build command is — check `package.json` scripts).
Expected: build succeeds. (No callers of `recording.sync` exist yet outside of `LinkCalibTab.jsx`, which we're rewriting in later tasks; the old key names are no longer used.)

If the build flags missing types or unused imports, fix them. If callers in the *current* `LinkCalibTab.jsx` still pass `vive_path`/`umi_path`, that file is being rewritten in Tasks 6–10, but to keep this commit green you can temporarily keep the old key names in `recording.sync` and remove them at the end. Easier: do this rename together with Task 6 (LinkCalibTab rewrite) in one commit. Implementer's choice — both ship green.

- [ ] **Step 3: Commit (or roll into Task 6 if build needs it)**

```bash
git add renderer/src/api/client.js
git commit -m "feat(client): add recording.importFile; rename recording.sync keys to a_path/b_path"
```

---

## Task 5: Frontend — slot module (state shape + ready predicate + WS hook)

**Files:**
- Create: `renderer/src/tabs/_linkSlot.js`

- [ ] **Step 1: Create the slot module**

Create `renderer/src/tabs/_linkSlot.js`:

```javascript
import { useCallback, useEffect, useRef } from 'react';
import { posesWsUrl } from '../api/client.js';

export const initialSlot = (overrides = {}) => ({
  mode: 'live',                 // 'live' | 'import'
  // live mode
  backend: 'mock',              // 'mock' | 'oculus' | 'steamvr'
  adbIp: '',
  fps: 30,
  connected: false,
  recording: false,
  recordedPath: null,
  recCount: 0,
  // import mode
  format: 'json',               // 'json' | 'yaml' | 'mcap'
  filePath: null,
  mcapTopics: [],
  mcapTopic: null,
  importedPath: null,
  importMeta: null,
  // shared
  devices: [],
  device: null,
  vizSamples: [],               // for trajectory rendering (live tail or imported full)
  liveCurT: null,
  ...overrides,
});

export function slotReady(s) {
  if (!s.device) return false;
  if (s.mode === 'live') return Boolean(s.recordedPath);
  return Boolean(s.importedPath);
}

// Returns the canonical recording-JSON path for a ready slot, or null.
export function slotPath(s) {
  if (!slotReady(s)) return null;
  return s.mode === 'live' ? s.recordedPath : s.importedPath;
}

/**
 * Per-slot WebSocket lifecycle. Opens when slot.mode === 'live' && wantConnected,
 * closes otherwise. Pushes hello.devices into the slot, and forwards sample/error
 * messages to the caller.
 *
 * Returns { wsRef, ticksRef, recordingActiveRef }.
 */
export function useSlotWs({ slot, setSlot, wantConnected, onHello, onSample, onError }) {
  const wsRef = useRef(null);
  const ticksRef = useRef({});       // { device: [{ts, present}] }
  const recordingActiveRef = useRef(false);

  const close = useCallback(() => {
    if (wsRef.current) { try { wsRef.current.close(); } catch { /* swallow */ } }
    wsRef.current = null;
  }, []);

  useEffect(() => {
    if (slot.mode !== 'live' || !wantConnected) {
      close();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = await posesWsUrl({
          fps: slot.fps,
          sources: [slot.backend],
          ip: slot.backend === 'oculus' && slot.adbIp ? slot.adbIp : undefined,
        });
        if (cancelled) return;
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => setSlot(s => ({ ...s, connected: true }));
        ws.onclose = () => {
          setSlot(s => ({ ...s, connected: false, recording: false }));
          recordingActiveRef.current = false;
          wsRef.current = null;
        };
        ws.onerror = () => onError?.('ws error');
        ws.onmessage = (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.type === 'hello') {
            const devices = Array.isArray(m.devices) ? m.devices : [];
            setSlot(s => ({
              ...s,
              devices,
              device: s.device && devices.includes(s.device) ? s.device : (devices[0] ?? null),
            }));
            ticksRef.current = Object.fromEntries(devices.map(d => [d, []]));
            onHello?.(m);
            return;
          }
          if (m.type === 'error') { onError?.(`${m.source}: ${m.message}`); return; }
          if (m.type !== 'sample') return;
          onSample?.(m);
        };
      } catch (e) {
        onError?.(`connect failed: ${e.message}`);
      }
    })();
    return () => { cancelled = true; close(); };
    // We deliberately depend on the connect-relevant slot fields only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.mode, slot.backend, slot.adbIp, slot.fps, wantConnected]);

  return { wsRef, ticksRef, recordingActiveRef };
}
```

- [ ] **Step 2: Sanity-check the build picks it up**

This module is unused so far, but it should at least parse. Run: `cd /home/mi/Calibration && npm run lint -- renderer/src/tabs/_linkSlot.js 2>&1 | tail -20` (or whatever the project's lint command is — check `package.json` scripts).
Expected: no syntax errors. Project-baseline warnings are fine; new errors are not.

- [ ] **Step 3: Commit**

```bash
git add renderer/src/tabs/_linkSlot.js
git commit -m "feat(link): add slot state model + per-slot WebSocket hook"
```

---

## Task 6: Frontend — gut LinkCalibTab and rebuild around two slots (skeleton)

**Files:**
- Modify: `renderer/src/tabs/LinkCalibTab.jsx` (full rewrite, header through closing brace)

This is the largest single task. It does **not** wire the Sync/Solve flow yet — Task 7 does. Goal: render two slot cards with mode toggles, get them to connect/disconnect/record/import correctly, and show trajectories in the existing viewport. Sync/Solve sections are present but their buttons are disabled with `TODO` comments that Task 7 fills in.

- [ ] **Step 1: Replace the entire file**

Replace `renderer/src/tabs/LinkCalibTab.jsx` with:

```jsx
import { useCallback, useMemo, useRef, useState } from 'react';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import {
  Scene3D, Tracker3D, Controller3D, Traj3D, RigidLink3D, Ground3D,
} from '../components/scene3d.jsx';
import { ErrorPanel, SolverPanel } from '../components/panels.jsx';
import { applyT, invT } from '../lib/math3d.js';
import { api, pickSaveFile, pickOpenFile, recording } from '../api/client.js';
import { useReportPoses } from '../lib/telemetry.jsx';
import { initialSlot, slotReady, useSlotWs } from './_linkSlot.js';

const TRAJ_DECIMATE_AT = 600;

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const stride = Math.ceil(arr.length / max);
  const out = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  return out;
}

function rpyDeg(R) {
  const r = (v) => (v * 180) / Math.PI;
  const sy = Math.hypot(R[0][0], R[1][0]);
  if (sy < 1e-6) return [r(Math.atan2(-R[1][2], R[1][1])), r(Math.atan2(-R[2][0], sy)), 0];
  return [r(Math.atan2(R[2][1], R[2][2])), r(Math.atan2(-R[2][0], sy)), r(Math.atan2(R[1][0], R[0][0]))];
}

export function LinkCalibTab() {
  const [slotA, setSlotA] = useState(() => initialSlot({ backend: 'steamvr' }));
  const [slotB, setSlotB] = useState(() => initialSlot({ backend: 'mock', format: 'mcap' }));
  const [linkLabel, setLinkLabel] = useState('a_to_b');
  const [showTraj, setShowTraj] = useState(true);
  const [showGround, setShowGround] = useState(true);
  const [showLink, setShowLink] = useState(true);
  const [showAfter, setShowAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);
  const [syncPath, setSyncPath] = useState('');
  const [syncDiag, setSyncDiag] = useState(null);
  const [solveMethod, setSolveMethod] = useState('daniilidis');
  const [tickCount, setTickCount] = useState(0);
  const [poseStats] = useState(null);
  useReportPoses(poseStats);

  // Tracks user intent for live-mode slots; the WS hook reacts to this.
  const [wantA, setWantA] = useState(false);
  const [wantB, setWantB] = useState(false);

  // Per-slot live sample buffers (refs to avoid re-render at 30 Hz).
  const slotsBufA = useRef({ viz: [], rec: [], curT: null }).current;
  const slotsBufB = useRef({ viz: [], rec: [], curT: null }).current;

  function handleSample(m, slot, buf) {
    const samplePoses = m.poses || {};
    const T = slot.device ? samplePoses[slot.device] : null;
    if (!T) return;
    buf.curT = T;
    buf.viz.push({ seq: m.seq, ts: m.ts, T });
    if (slot.recording && m.wall_ts != null) {
      buf.rec.push({ ts: m.wall_ts, T });
    }
    // Throttle re-renders.
    if (buf.viz.length % 10 === 0) setTickCount(n => n + 1);
  }

  const handleSampleA = useCallback((m) => handleSample(m, slotA, slotsBufA), [slotA, slotsBufA]);
  const handleSampleB = useCallback((m) => handleSample(m, slotB, slotsBufB), [slotB, slotsBufB]);

  useSlotWs({
    slot: slotA, setSlot: setSlotA, wantConnected: wantA,
    onSample: handleSampleA,
    onError: (msg) => setStatus(`A: ${msg}`),
  });
  useSlotWs({
    slot: slotB, setSlot: setSlotB, wantConnected: wantB,
    onSample: handleSampleB,
    onError: (msg) => setStatus(`B: ${msg}`),
  });

  // Live-mode controls --------------------------------------------------------
  const startRec = (slot, setSlot, buf) => {
    if (!slot.connected) { setStatus('connect first'); return; }
    buf.rec.length = 0;
    setSlot(s => ({ ...s, recording: true, recordedPath: null, recCount: 0 }));
  };

  const stopAndSaveRec = async (slot, setSlot, buf, label) => {
    setSlot(s => ({ ...s, recording: false }));
    const samples = buf.rec.slice();
    if (samples.length === 0) { setStatus(`${label}: nothing recorded`); return; }
    const path = await pickSaveFile({ defaultPath: `${label}_recording.json` });
    if (!path) { setStatus(`${label}: save cancelled`); return; }
    try {
      const r = await recording.save({ kind: 'vive', samples, path });
      setSlot(s => ({ ...s, recordedPath: r.path, recCount: r.n }));
      setStatus(`${label}: saved ${r.n} → ${path.split('/').pop()}`);
    } catch (e) { setStatus(`${label}: save failed: ${e.message}`); }
  };

  // Import-mode controls -----------------------------------------------------
  const importFile = async (slot, setSlot, label) => {
    const filters = slot.format === 'mcap'
      ? [{ name: 'MCAP', extensions: ['mcap'] }]
      : slot.format === 'yaml'
        ? [{ name: 'YAML', extensions: ['yaml', 'yml'] }]
        : [{ name: 'JSON', extensions: ['json'] }];
    const path = await pickOpenFile({ filters });
    if (!path) return;
    setSlot(s => ({ ...s, filePath: path, importedPath: null, mcapTopics: [], mcapTopic: null,
                    importMeta: null, devices: [], device: null }));
    setStatus(`${label}: loading…`);
    try {
      if (slot.format === 'mcap') {
        const t = await recording.listTopics(path);
        const topics = t.topics || [];
        if (topics.length === 0) { setStatus(`${label}: no PoseInFrame topics`); return; }
        setSlot(s => ({ ...s, mcapTopics: topics, mcapTopic: topics[0].topic }));
        setStatus(`${label}: ${topics.length} topics — pick one`);
      } else {
        const r = await recording.importFile({ path, format: slot.format });
        const dev = r.device || 'imported';
        setSlot(s => ({
          ...s,
          importedPath: r.path,
          importMeta: { n: r.count, t_first: r.t_first, t_last: r.t_last, device: r.device },
          devices: [dev],
          device: dev,
        }));
        setStatus(`${label}: loaded ${r.count} samples · Δ${(r.t_last - r.t_first).toFixed(1)}s`);
      }
    } catch (e) { setStatus(`${label}: import failed: ${e.message}`); }
  };

  const importMcapTopic = async (slot, setSlot, label) => {
    if (!slot.filePath || !slot.mcapTopic) return;
    const out_path = await pickSaveFile({ defaultPath: `${label}_umi.json` });
    if (!out_path) return;
    setStatus(`${label}: importing ${slot.mcapTopic}…`);
    try {
      const r = await recording.importMcap({ mcap_path: slot.filePath, topic: slot.mcapTopic, out_path });
      const dev = slot.mcapTopic.split('/').pop() || 'mcap';
      setSlot(s => ({
        ...s,
        importedPath: r.path,
        importMeta: { n: r.count, t_first: r.t_first, t_last: r.t_last, device: dev },
        devices: [dev],
        device: dev,
      }));
      setStatus(`${label}: imported ${r.count} · Δ${(r.t_last - r.t_first).toFixed(1)}s`);
    } catch (e) { setStatus(`${label}: import failed: ${e.message}`); }
  };

  // Mode flip wipes mode-specific state but preserves slot identity ----------
  const flipMode = (setSlot, setWant, mode) => {
    if (mode === 'live') setWant(false);
    setSlot(s => ({
      ...initialSlot(),
      mode,
      backend: s.backend, adbIp: s.adbIp, fps: s.fps, format: s.format,
    }));
  };

  // Solve gating + Sync/Solve handlers wired in Task 7. Stubs for now:
  const onSync = useCallback(async () => {
    setStatus('TODO: sync — implemented in Task 7');
  }, []);
  const onSolve = useCallback(async () => {
    setStatus('TODO: solve — implemented in Task 7');
  }, []);
  const onSaveYaml = useCallback(async () => {
    setStatus('TODO: save yaml — implemented in Task 7');
  }, []);
  const onLoadYaml = useCallback(async () => {
    setStatus('TODO: load yaml — implemented in Task 7');
  }, []);
  const solveGate = !syncDiag ? 'run sync first' : null;

  // Viewport data ------------------------------------------------------------
  const vizA = useMemo(() => {
    if (slotA.mode === 'live') return downsample(slotsBufA.viz, TRAJ_DECIMATE_AT);
    return [];  // imported visualization is loaded lazily in Task 7
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotA.mode, tickCount]);
  const vizB = useMemo(() => {
    if (slotB.mode === 'live') return downsample(slotsBufB.viz, TRAJ_DECIMATE_AT);
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotB.mode, tickCount]);
  const curA = slotA.mode === 'live' ? slotsBufA.curT : null;
  const curB = slotB.mode === 'live' ? slotsBufB.curT : null;

  const Tmat = result?.T ?? [
    [1, 0, 0, 0.05], [0, 1, 0, 0], [0, 0, 1, 0.05], [0, 0, 0, 1],
  ];
  const tVec = [Tmat[0][3], Tmat[1][3], Tmat[2][3]];
  const tMm = tVec.map(v => v * 1000);
  const tNorm = Math.hypot(...tMm);
  const R = [[Tmat[0][0], Tmat[0][1], Tmat[0][2]],
             [Tmat[1][0], Tmat[1][1], Tmat[1][2]],
             [Tmat[2][0], Tmat[2][1], Tmat[2][2]]];
  const rpy = rpyDeg(R);
  const rotRms = result?.ok ? result.rms : 0;
  const transRms = result?.ok ? (result.final_cost ?? 0) : 0;

  const histData = useMemo(() => result?.per_frame_err?.length ? result.per_frame_err : [], [result]);

  const predictedA = useMemo(() => {
    if (!result?.ok || !result.T || !vizB.length) return [];
    const Xi = invT(result.T);
    const offset = applyT(Xi, [0, 0, 0]);
    return vizB.map(s => applyT(s.T, offset));
  }, [result, vizB]);

  const vpW = 900, vpH = 620;
  const pts = (arr) => arr.map(s => applyT(s.T, [0, 0, 0]));
  const readyA = slotReady(slotA);
  const readyB = slotReady(slotB);

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>Link · A ↔ B</span>
          <span className="mono" style={{color: (readyA && readyB) ? 'var(--ok)' : 'var(--text-4)'}}>
            {readyA && readyB ? '● both ready' : '○ slot pending'}
          </span>
        </div>
        <div className="rail-scroll">
          <SlotCard
            label="A" slot={slotA} setSlot={setSlotA}
            wantConnected={wantA} setWantConnected={setWantA}
            buf={slotsBufA}
            onStartRec={() => startRec(slotA, setSlotA, slotsBufA)}
            onStopRec={() => stopAndSaveRec(slotA, setSlotA, slotsBufA, 'A')}
            onImportFile={() => importFile(slotA, setSlotA, 'A')}
            onImportMcapTopic={() => importMcapTopic(slotA, setSlotA, 'A')}
            onFlipMode={(mode) => flipMode(setSlotA, setWantA, mode)}
          />
          <SlotCard
            label="B" slot={slotB} setSlot={setSlotB}
            wantConnected={wantB} setWantConnected={setWantB}
            buf={slotsBufB}
            onStartRec={() => startRec(slotB, setSlotB, slotsBufB)}
            onStopRec={() => stopAndSaveRec(slotB, setSlotB, slotsBufB, 'B')}
            onImportFile={() => importFile(slotB, setSlotB, 'B')}
            onImportMcapTopic={() => importMcapTopic(slotB, setSlotB, 'B')}
            onFlipMode={(mode) => flipMode(setSlotB, setWantB, mode)}
          />

          <Section title="Mapping" hint={`${slotA.device || '—'} → ${slotB.device || '—'}`}>
            <Field label="link label">
              <input className="input" value={linkLabel}
                     onChange={e => setLinkLabel(e.target.value)}/>
            </Field>
          </Section>

          <Section title="Sync" hint={syncDiag ? `${syncDiag.n_pairs} pairs · Δt ${syncDiag.delta_t.toFixed(3)}s` : 'not synced'}>
            <button className="btn" onClick={onSync} disabled={!(readyA && readyB)}>⚡ sync</button>
            {syncDiag && (
              <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)',
                  display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                <span>Δt</span><span>{syncDiag.delta_t.toFixed(3)} s</span>
                <span>pairs</span><span>{syncDiag.n_pairs}</span>
                <span>A rot</span><span>{syncDiag.a_rot_deg.toFixed(1)}°</span>
                <span>B rot</span><span>{syncDiag.b_rot_deg.toFixed(1)}°</span>
              </div>
            )}
          </Section>

          <Section title="Solve" hint={solveGate ? 'gated' : 'ready'}>
            <Field label="method">
              <select className="select" value={solveMethod}
                      onChange={e => setSolveMethod(e.target.value)}>
                <option value="daniilidis">daniilidis</option>
                <option value="tsai">tsai</option>
                <option value="park">park</option>
                <option value="horaud">horaud</option>
                <option value="andreff">andreff</option>
              </select>
            </Field>
            <button className="btn primary" onClick={onSolve}
                    disabled={!!solveGate || busy} title={solveGate || ''}>
              ▶ Solve T_{linkLabel}
            </button>
            {solveGate && <div className="mono" style={{ fontSize: 10.5, color:'var(--warn)' }}>{solveGate}</div>}
          </Section>

          {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', padding: '0 2px' }}>{status}</div>}
        </div>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value="scene" onChange={()=>{}} options={[{value:'scene',label:'3D scene'}]}/>
          <Chk checked={showTraj} onChange={setShowTraj}>trajectories</Chk>
          <Chk checked={showLink} onChange={setShowLink}>rigid link</Chk>
          <Chk checked={showGround} onChange={setShowGround}>ground grid</Chk>
          <button
            className={`btn ${showAfter ? 'primary' : 'ghost'}`}
            disabled={!result?.ok}
            onClick={() => setShowAfter(v => !v)}>
            {showAfter ? '◉' : '○'} after extrinsics
          </button>
          <div className="spacer"/>
          <div className="read">
            {result?.ok
              ? <>‖t‖ <b>{tNorm.toFixed(2)} mm</b> · rot rms <b>{rotRms.toFixed(3)}°</b> · trans rms <b>{transRms.toFixed(2)} mm</b></>
              : <>{readyA && readyB ? 'awaiting sync/solve' : 'configure both slots'}</>}
          </div>
        </div>
        <div className="vp-body" style={{ gridTemplateColumns: '1fr', gap: 1, background: 'var(--view-border)' }}>
          <div className="vp-cell">
            <span className="vp-label">world</span>
            <Scene3D w={vpW} h={vpH}>
              {(cam) => (
                <g>
                  {showGround && <Ground3D cam={cam} size={0.6} step={0.05} z={-0.12}/>}
                  {showTraj && vizA.length > 1 && (
                    <Traj3D points={pts(vizA)} cam={cam} color="#ffa95a" dotEvery={8}/>
                  )}
                  {showTraj && vizB.length > 1 && (
                    <Traj3D points={pts(vizB)} cam={cam} color="#b78cff" dotEvery={8}/>
                  )}
                  {showAfter && predictedA.length > 1 && (
                    <Traj3D points={predictedA} cam={cam} color="#7fffbf" dotEvery={8}/>
                  )}
                  {curA && <Tracker3D    T={curA} cam={cam} label={slotA.device}/>}
                  {curB && <Controller3D T={curB} cam={cam} label={slotB.device}/>}
                  {showLink && curA && curB && (
                    <RigidLink3D
                      a={applyT(curA, [0,0,0])}
                      b={applyT(curB, [0,0,0])}
                      cam={cam} color="#e3bd56"/>
                  )}
                </g>
              )}
            </Scene3D>
          </div>
        </div>
      </div>

      <div className="rail">
        <div className="rail-header">
          <span>Results · T_{linkLabel}</span>
          <span className="mono" style={{color: result?.ok ? 'var(--ok)' : 'var(--text-4)'}}>
            {result?.ok ? `● ${transRms.toFixed(2)} mm` : busy ? '● solving' : '○ idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <Section title={`T · ${linkLabel}`}>
            <Matrix m={Tmat}/>
            <KV items={[
              ['t (mm)',  `[ ${tMm[0].toFixed(2)}, ${tMm[1].toFixed(2)}, ${tMm[2].toFixed(2)} ]`, ''],
              ['rpy (°)', `[ ${rpy[0].toFixed(3)}, ${rpy[1].toFixed(3)}, ${rpy[2].toFixed(3)} ]`, ''],
              ['||t||',   `${tNorm.toFixed(2)} mm`, 'pos'],
            ]}/>
          </Section>
          <Section title="Residuals" hint="per-pair deviation">
            <KV items={[
              ['rot rms',  `${rotRms.toFixed(4)}°`, rotRms < 0.5 ? 'pos' : 'warn'],
              ['trans rms',`${transRms.toFixed(3)} mm`, transRms < 2 ? 'pos' : 'warn'],
            ]}/>
          </Section>
          {histData.length > 0 && (
            <ErrorPanel rms={transRms} frames={histData.slice(0, 60)} histData={histData}/>
          )}
          <SolverPanel iters={result?.iterations || 0} cost={transRms} cond={0}
            algo="SE(3) chordal-mean + SVD projection"/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoadYaml}>↓ load</button>
          <button className="btn primary" style={{flex:1}} onClick={onSaveYaml} disabled={!result?.ok}>↑ save yaml</button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// SlotCard — one card per source slot.

function SlotCard({
  label, slot, setSlot, wantConnected, setWantConnected, buf,
  onStartRec, onStopRec, onImportFile, onImportMcapTopic, onFlipMode,
}) {
  const ready = slotReady(slot);
  const liveCount = slot.recording ? buf.rec.length : 0;
  const importHint = slot.importMeta
    ? `n=${slot.importMeta.n} · Δ${(slot.importMeta.t_last - slot.importMeta.t_first).toFixed(1)}s`
    : 'no file loaded';

  return (
    <Section title={`Source ${label}`} hint={ready ? '✓ ready' : slot.mode}>
      <Seg value={slot.mode} onChange={onFlipMode} full options={[
        {value:'live',   label:'● live'},
        {value:'import', label:'↓ import'},
      ]}/>

      {slot.mode === 'live' && (
        <>
          <Field label="backend">
            <select className="select" value={slot.backend} disabled={slot.connected}
                    onChange={e => setSlot(s => ({ ...s, backend: e.target.value }))}>
              <option value="mock">mock (Lissajous)</option>
              <option value="oculus">oculus (Quest3s)</option>
              <option value="steamvr">steamvr (Vive tracker)</option>
            </select>
          </Field>
          {slot.backend === 'oculus' && (
            <Field label="adb ip">
              <input className="input" placeholder="(blank = USB)" value={slot.adbIp}
                     disabled={slot.connected}
                     onChange={e => setSlot(s => ({ ...s, adbIp: e.target.value }))}/>
            </Field>
          )}
          <Field label="fps">
            <input type="number" className="input" value={slot.fps} min={1} max={120}
                   onChange={e => setSlot(s => ({ ...s, fps: +e.target.value || 30 }))}/>
          </Field>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
            {!slot.connected
              ? <button className="btn primary" onClick={() => setWantConnected(true)}>⚡ connect</button>
              : <button className="btn ghost" onClick={() => setWantConnected(false)}>⨯ disconnect</button>}
            {slot.connected && (
              slot.recording
                ? <button className="btn primary" onClick={onStopRec}>⏹ stop & save</button>
                : <button className="btn" onClick={onStartRec}>● record</button>
            )}
          </div>
          {slot.recording && <div className="mono" style={{ fontSize: 10.5 }}>{liveCount} samples buffered</div>}
          {slot.recordedPath && (
            <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>
              saved: {slot.recordedPath.split('/').pop()} ({slot.recCount})
            </div>
          )}
        </>
      )}

      {slot.mode === 'import' && (
        <>
          <Field label="format">
            <Seg value={slot.format} onChange={(v) => setSlot(s => ({
              ...s, format: v, filePath: null, importedPath: null,
              mcapTopics: [], mcapTopic: null, importMeta: null, devices: [], device: null,
            }))} full options={[
              {value:'json', label:'json'},
              {value:'yaml', label:'yaml'},
              {value:'mcap', label:'mcap'},
            ]}/>
          </Field>
          <button className="btn" onClick={onImportFile}>↓ pick {slot.format}…</button>
          {slot.format === 'mcap' && slot.mcapTopics.length > 0 && (
            <>
              <Field label="topic">
                <select className="select" value={slot.mcapTopic ?? ''}
                        onChange={e => setSlot(s => ({ ...s, mcapTopic: e.target.value }))}>
                  {slot.mcapTopics.map(t => (
                    <option key={t.topic} value={t.topic}>{t.topic} ({t.n})</option>
                  ))}
                </select>
              </Field>
              <button className="btn" onClick={onImportMcapTopic} disabled={!slot.mcapTopic}>
                import topic →
              </button>
            </>
          )}
          <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>{importHint}</div>
        </>
      )}

      <Field label="device">
        <select className="select" value={slot.device ?? ''}
                disabled={slot.devices.length === 0}
                onChange={e => setSlot(s => ({ ...s, device: e.target.value }))}>
          {slot.devices.length === 0 && <option value="">(none)</option>}
          {slot.devices.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </Field>
    </Section>
  );
}
```

- [ ] **Step 2: Run the app and verify each panel renders without crashing**

Run the dev server (project's standard command — likely `npm run dev`). Open the Link tab, then:

- Slot A defaults to live + steamvr; Slot B defaults to import + mcap.
- Toggle each slot between live and import — UI swaps cleanly, no console errors.
- In live + mock, click connect → record (a few seconds) → stop & save into `/tmp/slot_a.json`. Confirm the file exists and the slot now shows "saved:".
- In import + json, pick the file you just saved → device dropdown populates with one entry.
- Sync button is disabled until both slots are ready; once both are ready it becomes enabled (clicking it shows the `TODO: sync — implemented in Task 7` status).

Expected: rail layout matches the spec sketch; no React warnings about hooks or keys.

- [ ] **Step 3: Commit**

```bash
git add renderer/src/tabs/LinkCalibTab.jsx renderer/src/api/client.js
git commit -m "feat(link): rebuild Link tab around two symmetric source slots (UI skeleton)"
```

(If Task 4 was committed separately, drop `renderer/src/api/client.js` from this `git add`.)

---

## Task 7: Frontend — wire Sync, Solve, Save/Load YAML

**Files:**
- Modify: `renderer/src/tabs/LinkCalibTab.jsx` (replace the four stub callbacks `onSync`, `onSolve`, `onSaveYaml`, `onLoadYaml`, and the `solveGate` line; also import `slotPath`)

- [ ] **Step 1: Import `slotPath`**

In `renderer/src/tabs/LinkCalibTab.jsx`, change the slot-module import to:

```jsx
import { initialSlot, slotReady, slotPath, useSlotWs } from './_linkSlot.js';
```

- [ ] **Step 2: Replace the stubs**

In `renderer/src/tabs/LinkCalibTab.jsx`, replace the four stub callbacks with:

```jsx
  const onSync = useCallback(async () => {
    const a = slotPath(slotA);
    const b = slotPath(slotB);
    if (!a || !b) { setStatus('both slots must be ready'); return; }
    const out_path = await pickSaveFile({ defaultPath: `synced_${linkLabel}.json` });
    if (!out_path) return;
    setStatus('syncing…');
    try {
      const r = await recording.sync({ a_path: a, b_path: b, out_path });
      setSyncPath(r.path);
      setSyncDiag({
        delta_t: r.delta_t,
        n_pairs: r.n_pairs,
        a_rot_deg: r.a_rot_deg ?? r.vive_rot_deg,
        b_rot_deg: r.b_rot_deg ?? r.umi_rot_deg,
      });
      setStatus(`synced · Δt ${r.delta_t.toFixed(3)}s · ${r.n_pairs} pairs`);
    } catch (e) { setStatus(`sync failed: ${e.message}`); }
  }, [slotA, slotB, linkLabel]);

  const onSolve = useCallback(async () => {
    if (!syncPath) { setStatus('sync first'); return; }
    setBusy(true); setStatus('solving handeye…');
    try {
      const r = await recording.calibrateHandeyePose({ synced_path: syncPath, method: solveMethod });
      setResult(r);
      setStatus(r.ok ? `T_${linkLabel} · rms ${r.rms.toFixed(3)}° · ${r.message}` : `failed: ${r.message}`);
    } catch (e) { setStatus(`solve failed: ${e.message}`); }
    finally { setBusy(false); }
  }, [syncPath, solveMethod, linkLabel]);

  const onSaveYaml = useCallback(async () => {
    if (!result?.ok) { setStatus('nothing to save — run solve first'); return; }
    const p = await pickSaveFile({ defaultPath: `link_${linkLabel}.yaml` });
    if (!p) return;
    try {
      await api.saveCalibration({ path: p, kind: 'chain', result });
      setStatus(`saved → ${p}`);
    } catch (e) { setStatus(`save failed: ${e.message}`); }
  }, [result, linkLabel]);

  const onLoadYaml = useCallback(async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      setResult({
        ok: true, rms: d.rms ?? 0,
        T: d.T || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0, message: `loaded from ${p}`,
      });
      setStatus(`loaded ← ${p}`);
    } catch (e) { setStatus(`load failed: ${e.message}`); }
  }, []);
```

Also replace the `solveGate` line with the real diversity check:

```jsx
  const solveGate = (() => {
    if (!syncDiag) return 'run sync first';
    if (syncDiag.n_pairs < 50) return `only ${syncDiag.n_pairs} pairs (need ≥ 50)`;
    if (syncDiag.a_rot_deg < 30) return `A rotation diversity too low: ${syncDiag.a_rot_deg.toFixed(1)}°`;
    if (syncDiag.b_rot_deg < 30) return `B rotation diversity too low: ${syncDiag.b_rot_deg.toFixed(1)}°`;
    return null;
  })();
```

- [ ] **Step 3: Manual smoke — RT↔RT (mock + mock)**

Run dev server. Set both slots to live + mock. Connect both. Record both for ~10 s (enough samples + rotation). Stop & save each. Sync. Confirm `n_pairs > 50` and `a_rot_deg`, `b_rot_deg` both > 30. Solve. Result panel populates with a 4×4 T and rms.

- [ ] **Step 4: Manual smoke — RT↔Import (live + json)**

Take the JSON saved in Step 3 from Slot B. Switch Slot B to import + json, pick that file. Device dropdown auto-fills. Slot A still live + mock — record a fresh window. Sync. Solve. Confirm result.

- [ ] **Step 5: Manual smoke — Import↔Import (json + json)**

Switch both slots to import + json, pick the two saved files from Step 3. Sync. Solve. Confirm result.

- [ ] **Step 6: Manual smoke — Import↔Import (mcap + yaml)**

If you have an MCAP recording handy, set Slot A to import + mcap, pick the file, pick a topic, click "import topic →". Set Slot B to import + yaml, pick a YAML version of a recording (you can convert a JSON via `python -c "import json,yaml; yaml.safe_dump(json.load(open('a.json')), open('a.yaml','w'))"`). Sync. Solve.

If no MCAP is available, skip this step and note in the commit message.

- [ ] **Step 7: Manual smoke — mode flip does not disturb the other slot**

With Slot A live + connected + recording, flip Slot B between live ↔ import several times. Slot A's stream and recording counter must not blink.

- [ ] **Step 8: Save & re-load YAML**

After a successful Solve, click ↑ save yaml → pick a path → reload via ↓ load. The result panel re-populates.

- [ ] **Step 9: Commit**

```bash
git add renderer/src/tabs/LinkCalibTab.jsx
git commit -m "feat(link): wire Sync/Solve/SaveYaml/LoadYaml on the new two-slot Link tab"
```

---

## Task 8: Cleanup — delete dead state from old single-WS path

**Files:**
- Inspect: `renderer/src/tabs/LinkCalibTab.jsx`

- [ ] **Step 1: Sweep for leftover symbols from the old implementation**

Run: `grep -nE "inputsMode|seq.matched|umiPath|vivePath|recordingActiveRef|seq-match" renderer/src/tabs/LinkCalibTab.jsx`
Expected: no matches. If anything is found, delete it (the rewrite in Task 6 should have left none, but the symbol-sweep is cheap insurance).

- [ ] **Step 2: Run lint over the changed files**

Run: `cd /home/mi/Calibration && npm run lint -- renderer/src/tabs/LinkCalibTab.jsx renderer/src/tabs/_linkSlot.js renderer/src/api/client.js 2>&1 | tail -30`
Expected: clean (or only project-baseline warnings). Fix any new violations introduced by the rewrite.

- [ ] **Step 3: Run the full backend test suite**

Run: `cd backend && python -m pytest tests/ -v 2>&1 | tail -20`
Expected: all pass; in particular `test_recording_import_file.py`, `test_sync_endpoint.py`, `test_sync.py`, `test_import_mcap.py`, `test_handeye_pose.py`.

- [ ] **Step 4: Commit (only if Step 1 or Step 2 produced changes)**

```bash
git add -p
git commit -m "chore(link): clean up leftover symbols + lint"
```

---

## Task 9: Manual UI sweep + final commit message

**Files:** none (verification only)

- [ ] **Step 1: Walk all 4 mode combinations one more time**

Per the spec test plan: RT↔RT, RT↔Import, Import↔RT, Import↔Import. For each, end-to-end Sync → Solve → result. If anything is off, file a fix step inline.

- [ ] **Step 2: Verify the topbar telemetry pills still work for live slots**

When Slot A is live + connected, the topbar should still show the source / drop% pills. Currently `setPoseStats` is unused in the rewrite; if the topbar pills go dark, add a per-slot dropPct merge: gather from `wsA.ticksRef` / `wsB.ticksRef` (returned by `useSlotWs`) on a 500 ms interval, compute over the rolling 5 s window, merge into a single `{source: [...], bases, perDevice}` object, and pass to `setPoseStats`. Only required if the pills go dark.

- [ ] **Step 3: Final commit, if any cleanups happened**

```bash
git add -A
git commit -m "polish(link): finalize unified two-slot Link tab"
```

---

## Out of scope (per spec)

- Persisting slot config across sessions.
- Multi-link / multi-device chains.
- Custom sync algorithms beyond the wall-clock matcher.
- Removing the legacy seq-paired `/calibrate` link backend endpoint (still in use by ChainTab).
