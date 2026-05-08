# Calibration Workbench

Camera / fish-eye / hand-eye / kinematic-chain calibration GUI for VR rigs (HMD + controller + SteamVR + gripper).

Ships as a single-file AppImage on Linux (Windows / macOS later). User double-clicks, it runs — no Python or Node runtime to install.

## Architecture

```
┌──────────────────────────────┐          ┌──────────────────────────────┐
│  Electron renderer (React)   │   WS +   │  Python sidecar (FastAPI)    │
│  - modular UI, SVG viewport  │◄────────►│  - OpenCV calibration        │
│  - talks REST / WS to local  │  REST    │  - SteamVR pose stream       │
│    port chosen at startup    │          │  - frozen into one binary    │
└──────────────────────────────┘          └──────────────────────────────┘
         │                                         ▲
         └── spawned + monitored by Electron main ─┘
```

See `electron/sidecar.js` for the port-discovery + lifecycle logic; see `backend/app/` for the Python side.

## Layout

```
electron/       Electron main process (Node) — window, IPC, sidecar spawner
renderer/       React renderer (Vite) — tabs/panels/viewport/scene3d components
backend/        FastAPI + OpenCV calibration service (frozen with PyInstaller)
scripts/        dev.sh, build-backend.sh
```

## Develop (Linux)

Prereqs: Node 20+, Python 3.10+, system OpenGL libs for SteamVR (optional).

```bash
./scripts/dev.sh
```

That creates `backend/.venv`, installs Python deps, runs `npm install`, then starts Vite + Electron concurrently. Electron itself spawns the Python sidecar on a free localhost port and waits for `/health` before opening the window. Hot-reload works for the renderer; restart the script to pick up backend changes.

## Build a Linux AppImage

```bash
npm run build:linux
```

This runs:
1. `vite build` — renderer into `renderer/dist/`
2. `scripts/build-backend.sh` — PyInstaller `--onefile` → `backend/dist/calib-backend`
3. `electron-builder --linux` — bundles both into `dist/Calibration Workbench-<ver>-x64.AppImage`

The user double-clicks the AppImage; Electron main locates the frozen Python binary under `resources/backend/calib-backend` and launches it as a child process.

## Status

**Phase 1 (this commit) — scaffold.** Full modular UI (six tabs matching the design), Electron + Python wiring, AppImage build pipeline. Calibration endpoints are stubs that report `ok=false`.

**Phase 2 — wire OpenCV.** Each file under `backend/app/calib/` has a `TODO` marking the exact `cv2.*` call to plug in (`calibrateCamera`, `fisheye.calibrate`, `stereoCalibrate`, `calibrateHandEye`, + `scipy.optimize.least_squares` for the joint chain solve). Live streams: replace the WS heartbeat in `api/routes.py` with MJPEG from the camera source and SteamVR pose polling.

## Keyboard

- `Ctrl+,` — toggle tweaks panel (theme / density / accent hue)
