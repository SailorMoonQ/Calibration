# Pinhole intrinsics parity — design

Brings the IntrinsicsTab (pinhole calibration) to feature parity with the
already-polished FisheyeTab. Two scopes:

- **Group A — Live rectified preview.** Add a side-by-side raw / undistorted
  viewport driven by the current calibration, the way FisheyeTab does. Backend
  rectify endpoints learn a `model=pinhole` branch that uses
  `cv2.getOptimalNewCameraMatrix` + `cv2.initUndistortRectifyMap` /
  `cv2.undistort` instead of the fisheye-only API.
- **Group B — Capture UX.** Lift FisheyeTab's snap/drop/auto-capture/undo
  affordances and keyboard shortcuts into IntrinsicsTab.

Polish bits ("Group C" — `/stream/info` polling, `skipResultResetRef` for
load-with-dataset, richer load status) are out of scope and tracked
separately.

## Goals

- IntrinsicsTab shows raw and undistorted views side-by-side once
  calibration converges.
- Capture loop matches fisheye: snap to dataset, ⌘Z undo, drop bad frames,
  auto-capture by coverage cells, keyboard shortcuts.
- Existing FisheyeTab flow keeps working unchanged (back-compat default on
  every shared backend / renderer surface).

## Architecture (E1 — extend backend endpoints)

The fisheye-side rectification scaffolding (probe first frame, build maps,
encode MJPEG, handle disconnect) is identical between models. Only the K/D
math and one shape parameter change. Branch inside the existing routes
rather than duplicating the streaming code.

```
                    /stream/mjpeg_rect
                    /dataset/rectified
                          │
                ┌─────────┴──────────┐
       model='fisheye' (default)    model='pinhole'
       cv2.fisheye.*                cv2.* (non-fisheye)
       balance + fov_scale          alpha
```

Renderer-side, `RectifiedLivePreview` and `RectifiedFrame` are thin
URL→`<img>` wrappers. We add a `model` prop and pass it through to the URL
builders; the components themselves stay opaque to the math difference (C1).

## Backend changes

### `backend/app/api/routes.py`

- Both `/stream/mjpeg_rect` and `/dataset/rectified` accept a `model` query /
  body field. Default `'fisheye'` preserves existing behaviour.
- Pinhole branch reads an `alpha` field (clamped to `[0.0, 1.0]`) instead of
  `balance` + `fov_scale`. Fisheye branch ignores `alpha` and continues to
  read `balance` / `fov_scale`. Each branch silently ignores fields that
  belong to the other model so callers can safely include defaults for both.
- Rename helper `_fisheye_new_K(K, D, w, h, balance, fov_scale)` to
  `_new_K(model, K, D, w, h, **kwargs)`. Dispatch on model:
  - `'fisheye'`: existing `cv2.fisheye.estimateNewCameraMatrixForUndistortRectify`
    behaviour and degenerate-K fallback.
  - `'pinhole'`: `cv2.getOptimalNewCameraMatrix(K, D, (w,h), alpha)`. Mirror
    the degenerate-K fallback (focal scaling) for symmetry, even though the
    pinhole estimator is more numerically tame in practice.
- Map / undistort calls switch on model:
  - `method='remap'`: `cv2.initUndistortRectifyMap` (no `fisheye.` prefix
    when model is pinhole) + `cv2.remap`.
  - `method='undistort'`: `cv2.undistort` for pinhole, `cv2.fisheye.undistortImage`
    for fisheye.
- Unknown `model` value → 400.

### Backend tests (`backend/tests/test_pinhole_rectify.py`, new)

- `_new_K(model='pinhole', alpha=0.0|0.5|1.0, ...)` returns a 3×3 with
  positive focal lengths and a centre near `(w/2, h/2)`. Synthetic K/D — no
  image processing needed.
- `_new_K(model='pinhole', alpha=-1.0)` and `alpha=2.0` clamp without raising.
- A FastAPI `TestClient` POST to `/dataset/rectified` with `model='bogus'`
  returns 400.

## Renderer changes

### `renderer/src/api/client.js`

- `rectifiedMjpegUrl(device, opts)` and `fetchRectifiedBlob(opts)` accept
  `model` (default `'fisheye'`). When `model === 'pinhole'`, the URL
  query / JSON body carries `alpha` instead of `balance` + `fov_scale`.

### `renderer/src/components/RectifiedLivePreview.jsx` and `RectifiedFrame.jsx`

- Add `model` prop, default `'fisheye'`. Pass through to the URL builder.
- Add `alpha` prop alongside the existing `balance` / `fovScale`. Components
  forward unchanged — they don't read these props directly.

### `renderer/src/tabs/IntrinsicsTab.jsx`

Restructure to mirror FisheyeTab's three-rail + split viewport layout.

**Left rail.** Source / Live camera / Dataset / Target / Model (existing,
unchanged). Add a new "Undistortion preview" section with one slider for
`alpha` (0..1, default 0.5). Drop the existing static checkboxes
(`estimate skew`, `fix aspect ratio`, `bundle adjust extrinsics`, `use
robust loss`) — they were never wired to the solver. Add an `autoCapture`
toggle (re-uses fisheye's pattern: turning it on auto-enables
`liveDetect`).

**Viewport toolbar.** Replace `none|residuals|heatmap` overlay segment with
a `split | raw | rect` view-mode segment. Keep `board`, `origin`,
`detect live`, `residuals` (now a checkbox). Keep a `method` toggle
(`remap | undistort`) for parity with fisheye when view-mode is not `raw`.

**Viewport body.** Two cells when `split`: left is `rawCell`
(`LivePreview` / `LiveDetectedFrame` / `DetectedFrame`); right is
`rectifiedCell` using `RectifiedLivePreview` / `RectifiedFrame` with
`model='pinhole'`, `alpha`, `method`. Single cell for `raw` or `rect`.
Until calibration converges, the viewport collapses to `rawCell` only
(mirrors fisheye).

**Right rail.** Existing K, D, residuals, save/load — unchanged.

### Capture UX (mirror of fisheye)

All of these are direct ports of FisheyeTab patterns. We duplicate rather
than extract a shared hook so the diff stays reviewable; later refactor
into a hook is fine.

- **Undo stack.** Bounded LIFO of `{kind: 'snap'|'drop', path, trashPath?}`
  in `undoStackRef`. `pushUndo` on snap and drop; `onUndo` deletes the
  just-snapped file or restores from `.trash/`. Status messages append
  `· ⌘Z to undo`.
- **Drop / delete frame.** `onDrop` hits `/dataset/delete` for
  `datasetFiles[selected - 1]`, refreshes listing, updates `selected` so
  it doesn't dangle. Wired to `<CaptureControls onDrop={...} />`.
- **Auto-capture.** `onAutoMeta(meta)` reads `meta.corners` /
  `meta.image_size`, computes corner centroid, looks up the coverage cell,
  and snaps if the cell hasn't been claimed this session. 500 ms debounce.
  `snappedCellsRef` resets on `datasetPath` change. Wired into
  `LiveDetectedFrame.onMeta` only when `autoCapture` is on.
- **Keyboard shortcuts.** Global `keydown` guarded against form-control
  focus. `←/→` step the FrameStrip, `Space` snaps, `⌘Z` / `Ctrl-Z` undoes.
  Snap and undo callbacks held in refs so the listener attaches once.

## Files touched

| File | Change |
| --- | --- |
| `backend/app/api/routes.py` | `model=pinhole` branch on rectify endpoints; `_new_K` dispatch |
| `backend/tests/test_pinhole_rectify.py` (new) | `_new_K` math + endpoint dispatch coverage |
| `renderer/src/api/client.js` | `rectifiedMjpegUrl` / `fetchRectifiedBlob` accept `model`, `alpha` |
| `renderer/src/components/RectifiedLivePreview.jsx` | Forward `model`, `alpha` |
| `renderer/src/components/RectifiedFrame.jsx` | Forward `model`, `alpha` |
| `renderer/src/tabs/IntrinsicsTab.jsx` | Three-rail layout; alpha slider; split viewport; capture UX mirror |

## Out of scope (Group C)

- `/stream/info` polling for live resolution/fps readout.
- `skipResultResetRef` to keep a freshly-loaded calibration when the
  loaded dataset path triggers the listing effect.
- Richer load-status messages (rms + fx).
- Refactoring fisheye + pinhole capture UX into a shared hook.

## Manual test plan

No automated UI tests; the solver / endpoint math is covered by pytest.

1. Calibrate IntrinsicsTab → raw and rectified cells render side-by-side
   in `split` view.
2. Slide `alpha` 0 → 1 → rectified view recrops live (no stream tear-down
   beyond what URL change forces).
3. Toggle `method` `remap` / `undistort` → output looks identical (math
   says they should).
4. Snap with `Space`; ⌘Z deletes the just-snapped file.
5. Drop a bad frame; ⌘Z restores it.
6. Auto-capture on, sweep the board across the FOV → snaps fire only on
   newly-covered cells, no spam.
7. FisheyeTab regression — open it after these changes, run an old flow:
   no behaviour change.
