# PICO pose source via XRoboToolkit

**Status:** spec
**Date:** 2026-05-27

## Goal

Let the Link and Hand-Eye tabs stream live 6-DoF poses from a PICO headset and
its controllers, wired in the same shape as the existing Quest/Oculus source so
users pick "PICO" from the same tracker-source selectors they already use.

## Background

PICO ships no first-party SDK that lets a non-game-engine PC process subscribe
to controller poses. Its official SDKs (Unity OpenXR, Unreal OpenXR, Native
Android) all run *on the headset* inside an engine app and expose poses through
OpenXR; the PICO Command Line Utility is an adb-style admin tool with no
real-time pose API. There is therefore no PICO analogue of `oculus_reader`
(which scrapes adb logcat in-process).

The realistic Python path is **XRoboToolkit** (github.com/XR-Robotics), the
community robotics-teleop stack built on PICO's Native SDK:

- A **PICO-side client APK** reads OpenXR poses on-device and publishes them
  over the network.
- A **PC Service daemon** (`XRoboToolkit-PC-Service`, single-instance,
  Windows/Linux x86/aarch64) receives the stream and exposes it locally.
- A **pybind module** (`XRoboToolkit-PC-Service-Pybind`, import name
  `xrobotoolkit_sdk`) gives Python direct access.

Confirmed Python API:

```python
import xrobotoolkit_sdk as xrt
xrt.init()
left  = xrt.get_left_controller_pose()    # [x, y, z, qx, qy, qz, qw]
right = xrt.get_right_controller_pose()
head  = xrt.get_headset_pose()
xrt.close()
```

Poses are position + quaternion (7 floats), in the XRoboToolkit world frame
(meters, right-handed).

## Non-goals

- **No auto-spawn of the PC Service daemon.** The user launches it themselves
  (it is single-instance and may be shared with other tools). The source
  surfaces a clean error when `init()` cannot reach it.
- **No coordinate-frame remapping** between PICO / SteamVR / Oculus world axes.
  Hand-eye (AX=XB) and link calibration solve a *relative* transform, so the
  absolute world frame is irrelevant as long as it is consistent within one
  recording session. Documented here as a deliberate assumption.
- **No adb IP / network-ADB field.** Unlike Oculus, the PICO connection is owned
  by the PC Service, not by this app, so there is no per-connection IP param.
- **No bundling of `xrobotoolkit_sdk` into the default AppImage.** PICO is an
  opt-in extra, same spirit as the existing `steamvr` / `oculus` extras.

## Architecture

A new `PoseSource` subclass plus one line of manager registration. Everything
downstream (the `/poses/stream` WS route, the merge logic, ref-counting, the
renderer's WS client) is already source-agnostic and needs no structural change.

```
   PICO headset (XRoboToolkit client APK)
        │  network (TCP/UDP)
        ▼
   XRoboToolkit-PC-Service  (user-launched daemon, single instance)
        │  local IPC, via linked libs
        ▼
   xrobotoolkit_sdk (pybind)            ← third_party submodule, built from source
        │  xrt.get_*_pose()
        ▼
   app/sources/poses/pico.py  PicoPoseSource(PoseSource)
        │  poll() → {device: 4x4}
        ▼
   pose_manager  ("pico" builder, ref-counted)
        │
        ▼
   /poses/stream WS  ──►  HandEyeTab / LinkCalibTab  (UI: "PICO" option)
```

## Components

### 1. `backend/app/sources/poses/pico.py` (new)

`PicoPoseSource(PoseSource)`, mirroring `oculus.py` / `steamvr.py`:

- **`DEVICES = ["pico_ctrl_l", "pico_ctrl_r", "pico_hmd"]`** — three devices.
  PICO exposes a headset pose (Oculus does not), which cam↔HMD hand-eye needs.
- **`__init__`**: lazy `import xrobotoolkit_sdk as xrt`; call `xrt.init()`;
  translate `ImportError` and any init failure to `RuntimeError` with an
  actionable message ("build the pybind module / start the PC Service"). Hold
  the module handle on the instance.
- **`poll(t)`**: read the three poses; for each, convert `[x,y,z,qx,qy,qz,qw]`
  to a 4×4 nested list via `_pose7_to_4x4()`. Skip a device whose pose is
  `None` or all-zeros (momentarily untracked) instead of dropping the sample —
  same robustness contract as `steamvr.poll()`.
- **`hello()`**: `{"devices": DEVICES, "gt_T_a_b": None, "bases": 0}`.
- **`close()`**: `xrt.close()`, guarded.

Helper `_pose7_to_4x4(p) -> list[list[float]] | None`:
- Returns `None` for a missing pose or a zero-norm quaternion (untracked).
- Builds the rotation matrix from the unit quaternion `(qx,qy,qz,qw)`, places
  `(x,y,z)` in the translation column, bottom row `[0,0,0,1]`.

### 2. `backend/app/sources/poses/manager.py`

Add a builder and register it:

```python
def _build_pico(**kw) -> PoseSource:
    from app.sources.poses.pico import PicoPoseSource
    return PicoPoseSource()          # PC Service owns the headset link; ignore ip

_BUILDERS = {
    "oculus":  _build_oculus,
    "steamvr": _build_steamvr,
    "pico":    _build_pico,
}
```

### 3. `backend/app/api/routes.py`

No logic change. Update the `/poses/stream` docstring that currently names only
oculus/steamvr to include `pico`.

### 4. Renderer

- **`HandEyeTab.jsx`**:
  - Add `{ value: 'pico', label: 'PICO' }` to `TRACKER_SOURCES`.
  - Add a `picoDevice` state and a device `<select>` (controller L / R / HMD →
    `pico_ctrl_l` / `pico_ctrl_r` / `pico_hmd`).
  - Extend `trackerDeviceKey()` with the `pico` case.
  - Add `pico` to the connect-button gate
    (`trackerSource === 'oculus' || 'steamvr'` → also `'pico'`).
  - No IP field; the hint line reads e.g. "via XRoboToolkit PC Service".
- **`_linkSlot.js`**: `backend` may be `'pico'`; no `adbIp` for pico.
- **`LinkCalibTab.jsx`**: add `<option value="pico">pico (XRoboToolkit)</option>`
  to the slot backend `<select>`; the `adbIp` field stays gated to oculus.

### 5. Packaging & docs

- **`.gitmodules`**: add `third_party/XRoboToolkit-PC-Service-Pybind`.
- **`backend/pyproject.toml`**: add a `pico` optional-deps entry. Since
  `xrobotoolkit_sdk` is not on PyPI, the entry carries a comment pointing at the
  manual build rather than a resolvable requirement.
- **`INSTALL.md`**: a PICO section — build PC Service → build pybind →
  `setup.py install` into the backend venv → install the client APK on the
  headset → **launch the PC Service before connecting**.

## Error handling

| Condition | Behavior |
|-----------|----------|
| `xrobotoolkit_sdk` not built/installed | `__init__` raises `RuntimeError` ("PICO support not installed — see INSTALL.md"); WS route sends `{type:error}` and closes 1011, exactly like the oculus path. |
| PC Service not running / headset offline | `xrt.init()` fails → `RuntimeError` with a "start the PC Service / check headset" message. |
| A device momentarily untracked | `_pose7_to_4x4` returns `None`; that device is skipped for the tick; other devices still stream. |
| WS client disconnects | `pose_manager.release("pico")` drops the refcount; `close()` calls `xrt.close()` when the last consumer leaves. |

## Testing

- **Unit (no hardware):** test `_pose7_to_4x4` — identity quaternion → identity
  rotation; a known quaternion → expected matrix (compare to scipy); zero-norm
  quaternion and `None` → `None`. Test `PicoPoseSource.poll()` with
  `xrobotoolkit_sdk` monkeypatched to a stub returning canned 7-vectors,
  asserting the device map and skip-on-untracked behavior.
- **Manager:** `get("pico")` builds and ref-counts; `release` tears down once.
- **Manual (hardware):** with PC Service running and the APK on the headset,
  select PICO in the Hand-Eye and Link tabs, confirm the 3D scene tracks the
  controllers/HMD and the staleness/Hz readouts update.

## Open questions

None blocking. Frame-convention consistency is assumed per Non-goals; if a
future need arises to mix PICO with another source in one session, add an
explicit per-source frame transform then.
