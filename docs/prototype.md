# Calibration Workbench — Prototype Document

> **Project**　Calibration Workbench
> **Version**　0.1.0 (Phase 1 scaffold)
> **Owner**　SailorMoonQ
> **Last updated**　2026-05-05
> **Status**　🚧 Prototype — UI complete, calibration solvers wired, packaging green on Linux

---

## 1. Goal

A desktop GUI that walks an operator through every calibration step needed to align a VR rig: **camera intrinsics → fisheye intrinsics → hand-eye → tracker-to-controller link → controller-to-gripper chain**. Ships as a single double-clickable artifact (Linux AppImage today, Windows installer next) so the operator does not have to install Python, Node, or OpenCV.

> 💡 **One-line pitch**　“Open the app, plug in a camera, walk the board through five tabs, end with a `calibration.yaml` that downstream robot code consumes verbatim.”

---

## 2. Architecture

| Layer | Tech | Responsibility |
| --- | --- | --- |
| Renderer | React 18 + Vite, plain CSS variables | Modular UI, SVG viewport, scene3d preview, theming |
| Main process | Electron 33 | Window lifecycle, IPC, sidecar spawn + health-check, port discovery |
| Backend sidecar | FastAPI + Uvicorn (Python 3.10+) | OpenCV calibration solvers, MJPEG/WS streams, dataset I/O |
| Math | OpenCV 4.10 contrib, SciPy `least_squares`, NumPy <2 | Intrinsics / fisheye / extrinsics / hand-eye / chain bundle solve |
| Pose ingest | `triad-openvr` (SteamVR), `OculusReader` (Quest 3 over ADB), MCAP (UMI), ROS2 `rclpy` | Multi-source pose stream multiplexer |

```
┌──────────────────────────────┐          ┌──────────────────────────────┐
│  Electron renderer (React)   │   WS +   │  Python sidecar (FastAPI)    │
│  - tabs / panels / viewport  │◄────────►│  - OpenCV solvers            │
│  - REST + WS to localhost    │  REST    │  - SteamVR / UMI / ROS2 in   │
└──────────────────────────────┘          └──────────────────────────────┘
         │                                         ▲
         └── spawned + monitored by Electron main ─┘
```

> ⚠️ **Process model**　The renderer never imports Python directly. `electron/sidecar.js` picks a free port at startup, exports it via `preload.js`, and waits for `GET /health` to return 200 before showing the window. If the sidecar crashes mid-session, Electron restarts it and the renderer reconnects on the next REST call.

---

## 3. UI prototype — five tabs

The whole calibration flow lives behind a fixed top-bar plus a numbered tab strip. There is **no live/bag toggle, no import-yaml button, and no export-bundle button** on the topbar — those were removed in commit `4f8bdfa`. Every tab follows the same shell: source picker on the left, preview viewport in the middle, parameter / result panel on the right, log strip pinned to the bottom.

### 3.1 Tab map

| # | Tab | Solves | Inputs | Output |
| --- | --- | --- | --- | --- |
| 01 | **Pinhole** intrinsics | `K`, Brown-Conrady `D` | board snapshots from one camera | `intrinsics.yaml` |
| 02 | **Fish-eye** intrinsics | `K`, equidistant `k₁..k₄` | board snapshots from one fisheye camera | `fisheye.yaml` |
| 03 | **Hand-Eye** | `T_cam_tracker` | paired (image, tracker pose) samples | `handeye.yaml` |
| 04 | **Link** | `T_tracker_ctrl` | synced Vive ↔ UMI streams (MCAP) | `link.yaml` |
| 05 | **Chain** | `T_ctrl_gripper` (joint bundle adjust) | full pose chain | `chain.yaml` |

### 3.2 Per-tab wireframe (textual)

```
┌─ Topbar ─────────────────────────────────────────────────────────────┐
│  Calibration Workbench           sidecar ●  127.0.0.1:8765           │
├─ Tabs ───────────────────────────────────────────────────────────────┤
│ [01 Pinhole] [02 Fish-eye] [03 Hand-Eye] [04 Link] [05 Chain]        │
├─────────────────────┬───────────────────────────┬────────────────────┤
│  Source panel       │  Viewport                 │  Params / Result   │
│  - camera dropdown  │  - LivePreview MJPEG      │  - board geometry  │
│  - resolution       │  - DetectedFrame overlay  │  - solver toggles  │
│  - clip controls    │  - RectifiedFrame toggle  │  - K/D readout     │
│                     │  - scene3d (handeye+)     │  - reproj err hist │
├─────────────────────┴───────────────────────────┴────────────────────┤
│ LogStrip   solver: LM converged in 24 iters · Δcost 7.2e-7           │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.3 Hand-Eye tab specifics

The Hand-Eye tab is the only one that needs the pose subsystem. Tracker source picker sits **above** the dataset picker (commit `27dd24e`). Selecting a source opens `WS /poses/stream?sources=…`, which multiplexes mock / SteamVR / Oculus / ROS2 backends into one merged `{device_id: 4×4}` tick.

```
Tracker source ──┐
                 ├──► /poses/stream  (WS, fps≈30)
Dataset folder ──┘                        │
                                          ▼
                                  pose buffer
                                          │
        snap ─► /stream/snap  ──► poses.json (atomic tmp+rename)
                                          │
                                          ▼
                            /calibrate/handeye  ──► T_cam_tracker
```

> 🟢 **Quick-start**　`source /opt/ros/humble/setup.bash` then run the AppImage to enable the ros2 source. Skipping this is fine for USB cameras + SteamVR; the picker will show the *“rclpy unavailable”* hint instead of a hard error.

### 3.4 Tweaks panel (`Ctrl+,`)

Floating panel for theme (light/dark), density (compact/comfortable), and accent hue (single OKLCH slider drives `--accent`, `--accent-2`, `--accent-soft`, `--accent-line`).

---

## 4. Backend API surface (selected)

Full router in `backend/app/api/routes.py`. Grouping below is for the prototype doc only.

### 4.1 Health & discovery

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Sidecar liveness — Electron blocks window-show on this |
| GET | `/sources` | Cameras + SteamVR snapshot |
| GET | `/stream/devices` | Cameras only |
| GET | `/stream/ros2_topics` | Live discovery of `sensor_msgs/CompressedImage` topics |

### 4.2 Live video

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/stream/mjpeg?device=&fps=&quality=` | Raw MJPEG, sequence-gated so no frame is resent |
| GET | `/stream/mjpeg_rect?…fx&fy&cx&cy&k…&model=fisheye\|pinhole` | Live-rectified MJPEG |
| WS | `/stream/ws?device=&detect=1` | JPEG + corner-detection meta in a length-prefixed binary frame |

### 4.3 Dataset

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/stream/snap` | Single-camera snapshot |
| POST | `/stream/snap_pair` | Stereo snapshot — shared filename so the solver can pair by basename |
| POST | `/dataset/delete` / `/dataset/restore` | Soft delete via `<dir>/.trash/`, undo-friendly |
| POST | `/dataset/rectified` | Bake out a rectified JPEG for a single dataset frame |

### 4.4 Calibration solvers

| Method | Path | Solver |
| --- | --- | --- |
| POST | `/calibrate/intrinsics` | `cv2.calibrateCamera` |
| POST | `/calibrate/fisheye` | `cv2.fisheye.calibrate` |
| POST | `/calibrate/extrinsics` | `cv2.stereoCalibrate` |
| POST | `/calibrate/handeye` | `cv2.calibrateHandEye` (image-based) |
| POST | `/calibrate/handeye_pose` | Daniilidis / Tsai / Park / Horaud / Andreff (pose-only) |
| POST | `/calibrate/chain` | SciPy `least_squares` joint chain bundle |

### 4.5 Recording / sync

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/recording/save` | Persist a Vive or UMI sample list as JSON |
| POST | `/recording/import_mcap` | Decode `foxglove.PoseInFrame` from an MCAP |
| GET | `/recording/list_topics` | Peek at MCAP topics with the right schema |
| POST | `/recording/sync` | Time-align Vive ↔ UMI into paired samples |

### 4.6 Pose stream multiplex

| Channel | Protocol | Notes |
| --- | --- | --- |
| `WS /poses/stream?sources=mock,steamvr,oculus&fps=30&ip=…` | JSON over WS | First message `hello` declares device union; subsequent `sample` messages carry `{device_id: 4×4}` per tick |

---

## 5. Build & distribution

```bash
# dev — vite + electron + python sidecar
./scripts/dev.sh

# linux release
npm run build:linux
# → dist/Calibration Workbench-0.1.0-x86_64.AppImage

# windows release
npm run build:win
# → dist/Calibration Workbench-0.1.0-x64.{exe,portable.exe}
```

> ⚠️ **NumPy pin**　Backend requires `numpy<2`. ROS2 Humble’s `cv_bridge` is built against NumPy 1.x and segfaults under NumPy 2. The opencv-contrib-python warning that asks for `numpy>=2` is safe to ignore.

CI: GitHub Actions builds Linux AppImage + Windows installer on every tag (commit `2ac089c`).

---

## 6. Status & roadmap

### 6.1 Done

- [x] Six → five tab UI shell, theme/density tweaks, log strip
- [x] Electron ↔ Python sidecar lifecycle, free-port discovery, health-gated window
- [x] MJPEG raw + rectified streams (fisheye + pinhole), per-source resolution/clip control
- [x] Dataset list / preview / soft-delete + undo
- [x] `/calibrate/intrinsics`, `/calibrate/fisheye`, `/calibrate/extrinsics` wired to OpenCV
- [x] Hand-eye image + pose-only solvers (5 algorithms)
- [x] Pose-stream multiplexer with mock / SteamVR / Oculus / ROS2 backends
- [x] MCAP import, Vive↔UMI sync, paired-sample export
- [x] AppImage + Windows installer pipeline in GitHub Actions

### 6.2 In flight

- [ ] Replace placeholder log-strip lines with telemetry from `TelemetryProvider`
- [ ] Per-tab “save bundle” → single `calibration.yaml` rollup (the topbar Export was removed pending a tab-scoped replacement)
- [ ] Live tracker overlay in `scene3d` for Hand-Eye / Link / Chain tabs
- [ ] macOS code-signed `.dmg`

### 6.3 Out of scope (Phase 1)

- Multi-rig session management
- Cloud sync of calibration bundles
- Web build (Electron-only for now)

---

## 7. Open questions

| # | Question | Owner | Needed by |
| --- | --- | --- | --- |
| Q1 | Do we ship a frozen Python sidecar (PyInstaller) or keep the system-Python install path documented in `INSTALL.md`? | @SailorMoonQ | before 0.2.0 cut |
| Q2 | Should the Link tab accept raw MCAP without a pre-import step? | — | UX review |
| Q3 | Where do calibration bundles live by default — `~/.calibration/` or alongside the dataset folder? | — | before bundle export ships |

---

## Appendix A — Key files

| Path | Why it matters |
| --- | --- |
| `electron/main.js` | Window + sidecar lifecycle |
| `electron/sidecar.js` | Port discovery, health gate, restart-on-crash |
| `electron/preload.js` | Exposes the chosen sidecar port to the renderer |
| `renderer/src/App.jsx` | Tab routing, theme wiring, telemetry provider |
| `renderer/src/tabs/*Tab.jsx` | One file per calibration step |
| `backend/app/main.py` | FastAPI bootstrap, host/port from env |
| `backend/app/api/routes.py` | All HTTP + WS endpoints |
| `backend/app/calib/*` | Solvers — one module per calibration kind |
| `backend/app/sources/poses/*` | Mock / SteamVR / Oculus / ROS2 pose backends |
| `scripts/dev.sh` | One-shot dev bootstrap |
| `scripts/build-backend.sh` | PyInstaller `--onefile` build (currently optional) |

---

## Appendix B — How to import this doc into Lark

1. Open Lark Docs → **New** → **Import**.
2. Choose `docs/prototype.md` from this repo.
3. Lark renders headings, tables, callouts (`> 💡`, `> ⚠️`, `> 🟢`), task lists (`- [ ]`), and fenced code blocks natively. No conversion needed.
