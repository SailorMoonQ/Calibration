# Link tab — unified two-slot source design

**Date:** 2026-05-05
**Tab:** `renderer/src/tabs/LinkCalibTab.jsx`
**Related backend:** `backend/app/api/routes.py` (recording_*), `backend/app/calib/sync.py`, `backend/app/calib/handeye_pose.py`
**Supersedes:** `docs/superpowers/specs/2026-04-28-link-vive-umi-design.md` (asymmetric vive+umi flow)

## Problem

The Link tab currently has two parallel sub-flows toggled by `inputsMode`:

1. **live pair** — open a single WebSocket subscribing to two pose backends, collect samples in browser memory, solve via the legacy `/calibrate` link endpoint (seq-paired)
2. **vive + mcap** — record one Vive device live → save JSON; import a UMI MCAP → JSON; sync the two JSONs with wall-clock matching → JSON; solve via `/calibrate/handeye_pose`

The split is asymmetric and bakes in the assumption "one side is live Vive, the other is an imported MCAP". Real workflows want any of the four combinations:

| Slot A   | Slot B   |
|----------|----------|
| realtime | realtime |
| realtime | imported |
| imported | realtime |
| imported | imported |

…and for imported we want three formats: **json**, **yaml**, **mcap**.

The user also wants explicit **device mapping**: each slot picks one device, and the solve produces the extrinsics for that A-device → B-device pair.

## Goals

- One unified "Sources" section. No `inputsMode` toggle.
- Two independent, symmetric source slots (A and B).
- Each slot has two modes: **live** (Oculus / SteamVR / mock) or **import** (json / yaml / mcap).
- Each slot picks exactly one device.
- All four mode combinations work uniformly through the existing `/recording/sync` + `/calibrate/handeye_pose` pipeline.
- Solve output: `T_{A.device}_{B.device}`, with a user-overridable `link_label`.

## Non-goals

- Multi-device per slot (recording two Quest controllers in one slot, choosing one later). One slot = one device.
- Removing the seq-paired legacy `/calibrate` link path from the backend (still callable, just not used by this tab).
- Reworking the 3D viewport layout. Trajectory rendering stays single-pane, just gains static-trajectory support for imported slots.
- Multi-link chains. Still one A↔B link per solve.

## Approach (chosen: A — symmetric source-slot model)

Both modes normalize to the same on-disk format:

```json
{
  "meta": { "kind": "vive", "n": 1240, "t_first": 1714915200.123, "t_last": 1714915242.456, "device": "tracker_0" },
  "samples": [ { "ts": 1714915200.123, "T": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]] } ]
}
```

`ts` is a POSIX wall-clock epoch (seconds, float); `T` is a row-major 4×4 homogeneous transform. This is the format `/recording/save` and `/recording/import_mcap` already produce. A slot is **ready** once it has a JSON path on disk and a chosen device. Once both slots are ready, the existing `/recording/sync` does wall-clock matching → paired JSON → `/calibrate/handeye_pose` solves.

### Why not branch RT↔RT to the seq-paired solver
- Two solve paths to maintain, surprising user-visible behavior change when flipping a slot from live to file.
- Live samples already carry `wall_ts`, so wall-clock sync works fine for RT↔RT — the precision loss vs seq-pairing (~0–10 ms) is well below the threshold for SE(3) handeye solvers.
- One pipeline = one set of bugs, one set of diagnostics, one solve gate.

### Why not auto-spool every live source to a temp file (Approach C)
- Loses the live "watch as you wave the wand" feel for RT↔RT — and there's no functional reason to give that up; we just don't make it a separate code path.
- Live mode still streams to the viewport; the only file written is the recording captured on **stop & save**.

## Frontend design

### State model

Replace the current flat `useState` soup with two slot reducers. Sketch (final names may differ; semantics are the contract):

```js
// One per slot. `mode` is the discriminant.
const initialSlot = {
  mode: 'live',                  // 'live' | 'import'
  // live mode
  backend: 'mock',               // 'mock' | 'oculus' | 'steamvr'
  adbIp: '',                     // oculus only
  fps: 30,
  connected: false,
  recording: false,
  recordedPath: null,            // set after stop & save
  recCount: 0,
  // import mode
  format: 'json',                // 'json' | 'yaml' | 'mcap'
  filePath: null,
  mcapTopics: [],                // mcap only, populated by /recording/list_topics
  mcapTopic: null,
  importedPath: null,            // canonical path used by /recording/sync
  importMeta: null,              // { n, t_first, t_last, device? }
  // shared
  devices: [],                   // populated from hello.devices (live) or [meta.device] (import)
  device: null,                  // chosen by user, defaults to devices[0]
  vizSamples: [],                // for trajectory rendering: live tail or imported full
  liveCurT: null,                // current pose 4x4 (live only)
};
```

A slot is **ready** when:
- live: `recordedPath != null && device != null`
- import: `importedPath != null && device != null`

`ready(A) && ready(B)` enables Sync.

### Two independent WebSockets

Today the tab opens one WS subscribed to both backends. Switch to **one WS per live slot** (`wsA`, `wsB`):

- Each WS opens with `sources=[slot.backend]`, optionally `ip=slot.adbIp` for Oculus.
- Each WS owns its own `helloRef`, sample buffer, ticks ring, and `recordingActive` flag.
- A slot in import mode has no WS at all.
- This decouples slots: flipping A from steamvr to a file does not tear down B's stream.
- Topbar telemetry (`useReportPoses`) merges the per-slot dropPct stats into a single payload.

### UI layout — left rail

```
┌─ Source A ─────────────────┐  ┌─ Source B ─────────────────┐
│  [● live] [↓ import]       │  │  [● live] [↓ import]       │
│                            │  │                            │
│  …mode-specific body…      │  │  …mode-specific body…      │
│                            │  │                            │
│  device: [tracker_0    ▾]  │  │  device: [eef_pose     ▾]  │
│  status: 1240 samples ✓    │  │  status: 312 pts · 5.2s ✓  │
└────────────────────────────┘  └────────────────────────────┘

┌─ Mapping ───────────────────────────────────────────────────┐
│  link label: [tracker_to_eef]  → solves T_{A.dev → B.dev}   │
└─────────────────────────────────────────────────────────────┘

┌─ Sync ──────────────────────────────────────────────────────┐
│  [⚡ sync]   pairs 412 · Δt 0.018 s · Arot 87° · Brot 64°   │
└─────────────────────────────────────────────────────────────┘

┌─ Solve ─────────────────────────────────────────────────────┐
│  method [daniilidis ▾]  [▶ Solve T_a_b]                     │
└─────────────────────────────────────────────────────────────┘
```

### Slot body — live mode

```
backend: [mock | oculus | steamvr]
adb ip:  [____]                  (oculus only)
fps:     [30]
[⚡ connect | ⨯ disconnect]
[● record  | ⏹ stop & save]      → writes recording JSON to a temp path
device:  [select from hello.devices]
hint: "1240 samples buffered · saved → /tmp/.../slot_a.json"
```

### Slot body — import mode

```
format: [json | yaml | mcap]
file:   [pick…]                  → opens native file picker filtered by format
topic:  [select from list_topics] (mcap only, after picking)
device: [auto-filled from meta, editable if file lists multiple]
hint: "n=312 · Δ5.2 s · device=eef_pose"
```

### Viewport

- Live slot: animated trajectory tail (existing `viz.a` / `viz.b` logic), current pose marker via `Tracker3D` / `Controller3D`.
- Import slot: static trajectory drawn from the full `samples` array (decimated by existing `downsample()` cap), no animated current marker.
- "after extrinsics" overlay unchanged — depends only on `result.T` and `viz.b`.
- Per-slot color: A = `#ffa95a` (orange), B = `#b78cff` (purple), unchanged.

### Solve gating

- Sync button enabled iff both slots are ready.
- Solve button enabled iff `syncDiag.n_pairs >= 50 && syncDiag.a_rot_deg >= 30 && syncDiag.b_rot_deg >= 30 && !busy`. Same thresholds as today's `solveGate`, just renamed.
- Result panel and side-rail are unchanged.

### Behavior on mode flip

Flipping a slot's mode wipes only that slot's mode-specific state, not the other slot's:

- live → import: disconnect WS, drop `recordedPath`, keep nothing live-specific.
- import → live: drop `importedPath`, `mcapTopics`, etc., keep nothing import-specific.
- The chosen `device` is reset to `null` on either flip (devices list will repopulate).

## Backend design

### New endpoint: `/recording/import_file`

Handles `json` and `yaml` files. MCAP keeps using `/recording/import_mcap`.

```
POST /recording/import_file
body: { path: string, format: "json" | "yaml" }
returns: {
  ok: true,
  path: string,           // canonical normalized path (may equal input for json)
  count: int,
  t_first: float,
  t_last: float,
  device?: string,        // from meta, if present
}
```

Implementation:

1. Read the file.
2. For `yaml`: `yaml.safe_load`; for `json`: `json.load`. Dispatch by `format` field, not by extension, so a `.txt` with json contents still works.
3. Validate top-level shape: `{ samples: [{ ts: number, T: 4x4 }] }`. `meta` is optional; if present, surface `meta.device`.
4. If file is yaml, normalize to a json file under a temp dir (mirror what `/recording/import_mcap` does for mcap → json) and return that path. JSON files can be returned as-is.
5. Errors: 404 if missing, 400 if shape invalid (`samples missing`, `T not 4x4`, `ts not numeric`, etc.) — error body is `{detail: string}` matching existing endpoints.

### `/recording/sync` — keep generic, add aliases

Today's body is `{vive_path, umi_path, out_path, max_skew_s, max_pair_gap_s}` and the response contains `vive_rot_deg` / `umi_rot_deg`. The implementation in `backend/app/calib/sync.py` is symmetric — it doesn't care which side is "vive".

Change:
- Accept `a_path` / `b_path` as new keys; keep `vive_path` / `umi_path` as backward-compat aliases. New code prefers the new names.
- Response adds `a_rot_deg` / `b_rot_deg` mirroring the existing keys, both populated.
- No new functionality; this is a rename to remove the misleading naming.

### `/calibrate/handeye_pose` — unchanged

Already takes a generic `synced_path` and a `method`. The output is renamed in the UI from "T_vive_umi" to `T_{linkLabel}` but the endpoint itself is unchanged.

### `/recording/save` — unchanged

Live capture path keeps writing the existing format (`kind: "vive"`). The "vive" tag in `meta.kind` becomes a label, not a contract — the import normalizer accepts any `{samples}` JSON regardless of `meta.kind`.

## Files affected

**Frontend:**
- `renderer/src/tabs/LinkCalibTab.jsx` — major rewrite of the rail; viewport layout unchanged.
- `renderer/src/api/client.js` — add `recording.importFile({path, format})`; switch `recording.sync` to use new key names while keeping a thin compat shim.

**Backend:**
- `backend/app/api/routes.py` — new `recording_import_file` handler; `recording_sync` accepts new key names.
- `backend/tests/test_recording_import_file.py` — new (json + yaml roundtrip, malformed shapes, missing file).
- `backend/tests/test_sync.py` — extend to cover new key names with backward-compat alias.

**No changes:**
- `backend/app/calib/sync.py`
- `backend/app/calib/handeye_pose.py`
- `renderer/src/components/scene3d.jsx`
- 3D viewport rendering primitives.

## Open questions / explicit decisions

1. **Killing the seq-paired solver path for RT↔RT in the UI** — confirmed in the brainstorming round. Backend endpoint stays for chain-tab use.
2. **One device per slot** — confirmed. Multi-device-per-slot is out of scope.
3. **YAML schema** — same `{meta, samples}` shape as the JSON recording format, just YAML-encoded. No new schema.
4. **Live samples already wall-clock-stamped** — verified: `m.wall_ts` is present in the WS sample messages and is what the existing `recording_save` writes per sample.
5. **MCAP import remains as today** — separate endpoint with topic discovery; not collapsed into `/recording/import_file`.

## Test plan

**Frontend (manual smoke):**
- Each of the 4 mode combinations: connect / record / import → device selectable → sync → solve → result populates → save yaml.
- Mode flip on a slot does not disconnect the other slot's stream.
- Save & re-load yaml round-trips the result.

**Backend (automated):**
- `test_recording_import_file.py`: roundtrip valid json, valid yaml, reject missing file, reject `samples` missing, reject malformed `T`, surface `meta.device`.
- `test_sync.py`: existing vive/umi paths still pass; new a_path/b_path keys produce identical output.

## Out of scope

- Storing slot configuration to disk for next session (re-pick on reload is fine).
- Multi-link / multi-source chains.
- Custom sync algorithms beyond the existing wall-clock matcher.
