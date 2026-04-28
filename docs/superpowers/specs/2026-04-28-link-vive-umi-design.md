# Vive ↔ UMI link calibration — design

Adds a record-import-sync-calibrate pipeline to the LinkCalibTab so the user
can recover the rigid mounting between a SteamVR Vive tracker and a Genrobot
UMI headset's eef-pose VIO output. The Vive stream is live (over the
existing `/poses/stream` SteamVR source); the UMI stream comes off the
device's data card as an MCAP file with `foxglove.PoseInFrame` messages on
`/robot0/vio/eef_pose` (or a configurable topic).

## Goals

- Record a session of Vive-tracker poses to disk with wall-clock timestamps.
- Import a UMI MCAP file and extract its `PoseInFrame` stream.
- Sync the two streams by timestamp (cross-correlate to handle small clock
  skew, then nearest-neighbor pair).
- Solve `T_vive_umi` (the rigid mounting between the two tracking frames)
  via `cv2.calibrateHandEye` (AX = XB), since the two tracking systems live
  in unrelated world frames.

## Non-goals

- Multi-session merging — one Vive recording + one MCAP per solve.
- Online streaming from UMI — the device only writes to its card.
- Replacing the existing live-pair flow in LinkCalibTab — kept as a separate
  input mode under a Seg toggle.

## Architecture

```
                     ┌─────────────────────────┐
                     │   LinkCalibTab (RR)     │
                     │  inputs mode: vive+mcap │
                     └─┬───────┬───────┬───────┘
                       │       │       │
            ┌──────────▼─┐ ┌───▼──┐ ┌──▼─────┐
            │ /poses     │ │import│ │sync +  │
            │ /stream    │ │_mcap │ │solve   │
            │ (record)   │ │      │ │        │
            └──────┬─────┘ └───┬──┘ └────────┘
                   │           │
                   ▼           ▼
              vive.json   umi.json   ──►  synced.json   ──►  T_vive_umi
              (samples)   (samples)        (paired)
```

The two raw recordings (Vive and UMI) share a canonical schema:
```json
{
  "meta": { "kind": "vive" | "umi", "n": <int>, "t_first": <epoch_s>, "t_last": <epoch_s> },
  "samples": [{ "ts": <epoch_s>, "T": [[4x4]] }, ...]
}
```
The synced file uses a different sample shape — each entry holds both
poses for one paired tick:
```json
{
  "meta": { "kind": "synced", "n": <int>, "delta_t": <float_s> },
  "samples": [{ "ts": <epoch_s>, "T_vive": [[4x4]], "T_umi": [[4x4]] }, ...]
}
```
The calibration step reads only the synced file.

## Backend changes

### `app/api/routes.py`

- **`/poses/stream`** sample messages gain `"wall_ts": time.time()` (epoch
  seconds, float). The existing `"ts"` (monotonic, since stream start) is
  kept unchanged — `LinkCalibTab` (the only consumer in the renderer) just
  ignores `wall_ts` in its existing live-pair flow and reads it in the new
  recording flow.
- **New `POST /recording/save`** body `{ kind: "vive"|"umi", samples: [{ts, T}], path }`
  → writes the canonical JSON file; returns `{ok, path}`.
- **New `POST /recording/import_mcap`** body `{ mcap_path, topic, out_path }`
  → reads MCAP, extracts `PoseInFrame` messages on `topic`, builds 4×4 from
  position+quaternion, drops degenerate-quat samples, writes canonical
  JSON. Returns `{ok, count, t_first, t_last}`.
- **New `GET /recording/list_topics`** query `mcap_path` → returns
  `{topics: [{topic, n, schema}]}` filtered to topics with schema
  `foxglove.PoseInFrame`. Used by the renderer's import-topic dropdown.
- **New `POST /recording/sync`** body `{ vive_path, umi_path, out_path,
  max_skew_s = 5.0, max_pair_gap_s = 0.05 }` → cross-correlates speed
  signals to estimate `delta_t`, then nearest-neighbor pairs. Returns
  `{ok, n_pairs, delta_t, vive_rot_deg, umi_rot_deg, path}` and writes the
  synced file. 400 if `n_pairs < 50` or rotation diversity insufficient.
- **New `POST /calibrate/handeye_pose`** body `{ synced_path, method }`
  (method ∈ `daniilidis|tsai|park|horaud|andreff`, default `daniilidis`)
  → returns the existing `CalibrationResult` shape with `T = T_vive_umi`,
  `rms = mean residual`, `per_frame_err = list[float]`, plus `delta_t` and
  `n_pairs` echoed for the UI.

### `app/calib/handeye_pose.py` (new)

~80-line module wrapping `cv2.calibrateHandEye` for the no-image case.
Inputs: synced sample list. Output: `CalibrationResult` (same shape as
existing kinds). Per-pair residuals: chordal angle in degrees + position
mismatch in mm.

A new module instead of extending `app/calib/handeye.py` because the
existing one is hard-wired to a `solvePnP`-from-board flow; tangling two
request shapes into one module would hurt readability.

### `app/calib/sync.py` (new)

Helper module for the sync algorithm:

1. Resample both streams to 50 Hz on a common time grid (linear
   interpolation on positions; for orientation, sample-and-hold is fine for
   the speed-signal step).
2. Compute `‖dx/dt‖` per stream.
3. Cross-correlate the two speed signals over `[-max_skew_s, +max_skew_s]`;
   peak position = `delta_t`. Bail (return error) if peak / mean < 3 ×
   (low SNR — usually means the user moved too little or the streams don't
   overlap).
4. With offset applied, walk the merged timeline, nearest-neighbor pair
   within `max_pair_gap_s`. Drop unmatched samples.
5. Compute rotation diversity per stream (max angle traversed by quaternion
   relative to the first quaternion). Surface as warnings if low.

### Backend deps

Add `mcap-protobuf>=0.4` to `[project.optional-dependencies] dev`. The
package reads the schema embedded in the MCAP, so we don't need to ship
`.proto` files.

### Backend tests

- `tests/test_sync.py` — unit tests for the sync helper. Synthesise two
  toy streams with a known `delta_t = 0.3 s` and verify recovery within
  10 ms. Verify rotation-diversity gate triggers on a static stream.
- `tests/test_handeye_pose.py` — synth two synced streams from a known
  ground-truth `T_vive_umi`, run the solver, verify recovered `T` is within
  1 mm / 0.1° of truth (Daniilidis is reasonably tight on synthetic).
- `tests/test_import_mcap.py` — fixture: tiny MCAP file with a few
  `PoseInFrame` messages (built in-test using `mcap_protobuf` writer).
  Verify the importer extracts the right count, timestamps, and 4×4 shape.

## Renderer changes

### New API client functions in `renderer/src/api/client.js`

- `recordingSave({ kind, samples, path })` → POST `/recording/save`.
- `recordingImportMcap({ mcap_path, topic, out_path })` → POST.
- `recordingListTopics(mcap_path)` → GET.
- `recordingSync({ vive_path, umi_path, out_path })` → POST.
- `calibrateHandeyePose({ synced_path, method })` → POST.

### `renderer/src/tabs/LinkCalibTab.jsx`

Inputs-mode Seg at the top of the left rail:

```
[ live pair | vive + mcap ]
```

`live pair` mode = the existing rail unchanged. `vive + mcap` mode shows
four sections:

1. **Vive recording** — source dropdown (constrained to `steamvr`/`mock`),
   connect/disconnect, `Start recording` / `Stop & save` buttons, status
   line showing sample count + duration, saved file path.
2. **UMI MCAP** — `Import MCAP` button (file picker), topic dropdown
   (populated by `/recording/list_topics`), loaded sample count + duration.
3. **Sync** — `Sync` button, diagnostic readout (`Δt`, `n_pairs`, rotation
   diversity per side).
4. **Solve** — method dropdown, `Solve T_vive_umi` button.

The existing `recordingRef` (already a renderer-side ref since the topbar
telemetry feature) is reused for the in-progress capture buffer; on `Stop &
save` it's POSTed to `/recording/save`.

**Solve gating.** The solve button is disabled until: both saved files
exist (paths held in tab state), `sync` has succeeded with `n_pairs ≥ 50`,
and `min(vive_rot_deg, umi_rot_deg) ≥ 30°`. Tooltip names the failing gate.

**Viewport.** The existing Scene3D + trajectory viz works for both modes.
In `vive + mcap` mode, after sync the renderer can render the two
trajectories side-by-side (no shared frame yet — that's what we're solving
for); after solve, the rigid link visualization draws between the synced
current poses.

**Right rail.** Existing `T_a_b` matrix and residual histogram panes show
`T_vive_umi` and the per-pair residuals.

## Edges and reliability

- **MCAP files are large** (the example is 132 MB). The importer streams
  message-at-a-time via `mcap` reader iterators; never loads the file as a
  bytes blob. Memory for ~30 k decoded `PoseInFrame` messages is < 5 MB.
- **Pose `frame_id` mismatch.** UMI's `PoseInFrame.frame_id` (e.g. `world`)
  isn't validated — this calibration's whole purpose is to align two
  unrelated world frames. We log the frame_id for diagnostics but don't
  gate on it.
- **Degenerate quaternion** in either stream during sensor warmup is
  filtered at import time (`‖q‖ < 0.5` → skip).
- **Sync SNR check.** Cross-correlation peak must exceed 3× mean to count
  as locked; otherwise the endpoint returns 400 with a clear message
  (usually means the user didn't move during recording).
- **Clock drift over a 60 s session.** Real NTP-synced clocks drift well
  under 50 ms over a minute, so we model the offset as constant. Slope
  estimation is overkill at this scale and explicitly out of scope.
- **Renderer crash mid-recording.** Loses the in-memory buffer; user
  re-records (acceptable per scope).

## Manual test plan

1. With Vive tracker connected and SteamVR running:
   - Open LinkCalibTab → switch to `vive + mcap` mode.
   - Connect SteamVR source; click Start recording, wave the rig with the
     attached UMI through varied orientations for ~30 s; click Stop & save.
   - Verify saved JSON has `kind=vive`, `n` matches expected sample count,
     `T` is 4×4, `ts` is a recent epoch timestamp.
2. Click Import MCAP, pick the corresponding UMI file. Verify topic
   dropdown shows `/robot0/vio/eef_pose`. Click confirm; loaded count
   shows non-zero.
3. Click Sync. Verify `Δt` is small (|Δt| < 1 s if clocks are NTP), pair
   count > 50, both rotation diversities > 30°.
4. Click Solve (default Daniilidis). Verify a 4×4 `T_vive_umi` appears in
   the right rail and per-pair residuals are < 5 mm / 1° (typical for a
   well-recorded session).
5. Try alternate methods (`tsai`, `park`) — results should agree within
   2 mm / 0.5° on a clean session.
6. Save / Load via existing buttons round-trips the calibration.
7. Switch to `live pair` mode → existing flow is unchanged, mock/steamvr
   pair calibration still solves (chain.py is wrong but unchanged here —
   that's a separate spec).

## Out of scope

- Replacing chain.py for the live-pair flow (different spec).
- Online MCAP streaming.
- Multi-segment / merged recordings.
- Slope-based clock drift correction.
- Visual indicator that `T_vive_umi` rotation is right-handed (a sanity
  check we can add later if results look mirrored).
