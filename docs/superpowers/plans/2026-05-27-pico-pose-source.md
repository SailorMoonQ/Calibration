# PICO Pose Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PICO headset/controller pose source (via the XRoboToolkit `xrobotoolkit_sdk` pybind module) selectable from the Hand-Eye and Link tabs, wired in the same shape as the existing Oculus source.

**Architecture:** A new `PicoPoseSource(PoseSource)` reads position+quaternion poses from `xrobotoolkit_sdk`, converts them to 4×4 matrices, and is registered in the ref-counted `pose_manager` under the key `"pico"`. The `/poses/stream` WS route is already source-agnostic, so only the manager and the renderer's source selectors change. `xrobotoolkit_sdk` is not on PyPI, so it is vendored as a submodule and built from source; the backend imports it lazily so its absence never breaks the app.

**Tech Stack:** Python (FastAPI backend, numpy), pytest, React (renderer), git submodules.

**Spec:** `docs/superpowers/specs/2026-05-27-pico-pose-source-design.md`

---

## File Structure

- **Create** `backend/app/sources/poses/pico.py` — `PicoPoseSource` + `_pose7_to_4x4` helper.
- **Create** `backend/tests/test_pico_pose.py` — unit tests (no hardware; `xrobotoolkit_sdk` stubbed).
- **Modify** `backend/app/sources/poses/manager.py` — add `_build_pico`, register `"pico"`.
- **Modify** `backend/app/api/routes.py` — extend the `/poses/stream` docstring.
- **Modify** `backend/pyproject.toml` — add a `pico` optional-deps entry (documented, non-PyPI).
- **Modify** `.gitmodules` + add submodule `third_party/XRoboToolkit-PC-Service-Pybind`.
- **Modify** `renderer/src/tabs/HandEyeTab.jsx` — add PICO tracker source + device selector.
- **Modify** `renderer/src/tabs/LinkCalibTab.jsx` — add PICO slot backend option.
- **Modify** `renderer/src/tabs/_linkSlot.js` — update the `backend` field comment.
- **Modify** `INSTALL.md` — PICO setup section.

---

## Task 1: Pose conversion helper `_pose7_to_4x4`

**Files:**
- Create: `backend/app/sources/poses/pico.py`
- Test: `backend/tests/test_pico_pose.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_pico_pose.py`:

```python
"""PicoPoseSource maps xrobotoolkit_sdk's [x,y,z,qx,qy,qz,qw] poses to 4x4
matrices and skips momentarily-untracked devices. xrobotoolkit_sdk is stubbed
so these tests need no PICO hardware or PC Service."""
from __future__ import annotations

import math

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from app.sources.poses.pico import _pose7_to_4x4


def test_identity_quat_is_translation_only():
    m = _pose7_to_4x4([1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0])
    assert m is not None
    expected = [
        [1.0, 0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0, 2.0],
        [0.0, 0.0, 1.0, 3.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    np.testing.assert_allclose(np.array(m), np.array(expected), atol=1e-9)


def test_rotation_matches_scipy():
    # 90 deg about Z, then translate.
    q = Rotation.from_euler("z", 90, degrees=True).as_quat()  # [qx,qy,qz,qw]
    m = _pose7_to_4x4([0.5, -0.5, 0.0, q[0], q[1], q[2], q[3]])
    R = np.array(m)[:3, :3]
    np.testing.assert_allclose(R, Rotation.from_quat(q).as_matrix(), atol=1e-9)
    assert [m[0][3], m[1][3], m[2][3]] == [0.5, -0.5, 0.0]


def test_zero_quaternion_returns_none():
    assert _pose7_to_4x4([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) is None


def test_none_and_bad_length_return_none():
    assert _pose7_to_4x4(None) is None
    assert _pose7_to_4x4([1.0, 2.0, 3.0]) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_pico_pose.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sources.poses.pico'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/sources/poses/pico.py`:

```python
"""PICO pose source via XRoboToolkit's PC-Service pybind module.

The module (`xrobotoolkit_sdk`) is built from source — see INSTALL.md — and
talks to a user-launched XRoboToolkit PC Service daemon, which in turn receives
poses over the network from the XRoboToolkit client APK on the headset. We
expose the two controllers and the headset.

`xrobotoolkit_sdk` returns each pose as [x, y, z, qx, qy, qz, qw] (meters +
unit quaternion); we convert to the 4x4 nested-list contract every PoseSource
returns from poll().
"""
from __future__ import annotations

import logging
import math

from app.sources.poses import PoseSource

log = logging.getLogger("calib.source.pico")

DEVICES = ["pico_ctrl_l", "pico_ctrl_r", "pico_hmd"]


def _pose7_to_4x4(p) -> list[list[float]] | None:
    """Convert [x,y,z,qx,qy,qz,qw] to a 4x4 row-major nested list.

    Returns None for a missing/short pose or a zero-norm quaternion (the
    signal XRoboToolkit gives for a momentarily-untracked device).
    """
    if p is None or len(p) != 7:
        return None
    x, y, z, qx, qy, qz, qw = (float(v) for v in p)
    n = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if n < 1e-9:
        return None
    qx, qy, qz, qw = qx / n, qy / n, qz / n, qw / n
    return [
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw),     2 * (qx * qz + qy * qw),     x],
        [2 * (qx * qy + qz * qw),     1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),     y],
        [2 * (qx * qz - qy * qw),     2 * (qy * qz + qx * qw),     1 - 2 * (qx * qx + qy * qy), z],
        [0.0, 0.0, 0.0, 1.0],
    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_pico_pose.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/sources/poses/pico.py backend/tests/test_pico_pose.py
git commit -m "feat: add PICO pose7->4x4 conversion helper"
```

---

## Task 2: `PicoPoseSource` class

**Files:**
- Modify: `backend/app/sources/poses/pico.py`
- Test: `backend/tests/test_pico_pose.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_pico_pose.py`:

```python
import sys
import types


def _fake_xrt(left, right, head):
    m = types.ModuleType("xrobotoolkit_sdk")
    m.init = lambda: None
    m.close = lambda: None
    m.get_left_controller_pose = lambda: left
    m.get_right_controller_pose = lambda: right
    m.get_headset_pose = lambda: head
    return m


def _make_source(monkeypatch, fake):
    monkeypatch.setitem(sys.modules, "xrobotoolkit_sdk", fake)
    from app.sources.poses.pico import PicoPoseSource
    return PicoPoseSource()


def test_hello_lists_three_devices(monkeypatch):
    src = _make_source(monkeypatch, _fake_xrt(None, None, None))
    h = src.hello()
    assert h["devices"] == ["pico_ctrl_l", "pico_ctrl_r", "pico_hmd"]
    assert h["bases"] == 0


def test_poll_maps_all_devices(monkeypatch):
    src = _make_source(monkeypatch, _fake_xrt(
        [1, 0, 0, 0, 0, 0, 1], [0, 2, 0, 0, 0, 0, 1], [0, 0, 3, 0, 0, 0, 1]))
    out = src.poll(0.0)
    assert set(out) == {"pico_ctrl_l", "pico_ctrl_r", "pico_hmd"}
    assert out["pico_ctrl_l"][0][3] == 1.0
    assert out["pico_ctrl_r"][1][3] == 2.0
    assert out["pico_hmd"][2][3] == 3.0


def test_poll_skips_untracked_device(monkeypatch):
    # left zero-quat (untracked), head None — both skipped; right survives.
    src = _make_source(monkeypatch, _fake_xrt(
        [0, 0, 0, 0, 0, 0, 0], [5, 6, 7, 0, 0, 0, 1], None))
    out = src.poll(0.0)
    assert set(out) == {"pico_ctrl_r"}


def test_init_failure_raises_runtimeerror(monkeypatch):
    bad = types.ModuleType("xrobotoolkit_sdk")
    def _boom():
        raise OSError("PC Service not reachable")
    bad.init = _boom
    monkeypatch.setitem(sys.modules, "xrobotoolkit_sdk", bad)
    from app.sources.poses.pico import PicoPoseSource
    with pytest.raises(RuntimeError, match="PICO"):
        PicoPoseSource()


def test_missing_module_raises_runtimeerror(monkeypatch):
    monkeypatch.setitem(sys.modules, "xrobotoolkit_sdk", None)  # forces ImportError
    from app.sources.poses.pico import PicoPoseSource
    with pytest.raises(RuntimeError, match="INSTALL"):
        PicoPoseSource()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_pico_pose.py -v`
Expected: FAIL — `ImportError: cannot import name 'PicoPoseSource'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/app/sources/poses/pico.py`:

```python
class PicoPoseSource(PoseSource):
    def __init__(self) -> None:
        try:
            import xrobotoolkit_sdk as xrt  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "PICO support not installed — build xrobotoolkit_sdk and see "
                "INSTALL.md (PICO section)"
            ) from e
        try:
            xrt.init()
        except Exception as e:
            raise RuntimeError(
                f"PICO init failed: {e} — is the XRoboToolkit PC Service running "
                "and the headset connected?"
            ) from e
        self._xrt = xrt
        log.info("PicoPoseSource initialized via xrobotoolkit_sdk")

    def hello(self) -> dict:
        return {"devices": list(DEVICES), "gt_T_a_b": None, "bases": 0}

    def poll(self, t: float) -> dict[str, list[list[float]]]:
        readers = (
            ("pico_ctrl_l", self._xrt.get_left_controller_pose),
            ("pico_ctrl_r", self._xrt.get_right_controller_pose),
            ("pico_hmd", self._xrt.get_headset_pose),
        )
        out: dict[str, list[list[float]]] = {}
        for dev, read in readers:
            try:
                m = _pose7_to_4x4(read())
            except Exception:
                continue
            if m is not None:
                out[dev] = m
        return out

    def close(self) -> None:
        try:
            self._xrt.close()
        except Exception:
            log.exception("xrobotoolkit_sdk close failed")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_pico_pose.py -v`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/sources/poses/pico.py backend/tests/test_pico_pose.py
git commit -m "feat: add PicoPoseSource reading xrobotoolkit_sdk poses"
```

---

## Task 3: Register `"pico"` in the pose manager

**Files:**
- Modify: `backend/app/sources/poses/manager.py:20-34`
- Test: `backend/tests/test_pose_manager.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_pose_manager.py`:

```python
def test_pico_builder_is_registered():
    # The real builder is registered (not the monkeypatched _BUILDERS); assert
    # the key exists and is callable without constructing it (which needs hw).
    assert "pico" in pose_manager._BUILDERS
    assert callable(pose_manager._BUILDERS["pico"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_pose_manager.py::test_pico_builder_is_registered -v`
Expected: FAIL — `assert 'pico' in {...}` (KeyError-style assertion failure)

- [ ] **Step 3: Write minimal implementation**

In `backend/app/sources/poses/manager.py`, add the builder after `_build_steamvr` (around line 29):

```python
def _build_pico(**kw) -> PoseSource:
    # XRoboToolkit's PC Service owns the headset link, so no ip param is used.
    from app.sources.poses.pico import PicoPoseSource
    return PicoPoseSource()
```

Then add it to the `_BUILDERS` dict:

```python
_BUILDERS: dict[str, Callable[..., PoseSource]] = {
    "oculus":  _build_oculus,
    "steamvr": _build_steamvr,
    "pico":    _build_pico,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_pose_manager.py -v`
Expected: PASS (all pose_manager tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add backend/app/sources/poses/manager.py backend/tests/test_pose_manager.py
git commit -m "feat: register pico pose source in manager"
```

---

## Task 4: Update `/poses/stream` docstring

**Files:**
- Modify: `backend/app/api/routes.py:1175-1181`

- [ ] **Step 1: Update the docstring**

In `backend/app/api/routes.py`, change the `poses_stream` docstring lines that list sources:

Find:
```python
      - sources: comma list, e.g. "steamvr" or "oculus,steamvr"
      - ip:      optional IP for network ADB (applies to the oculus source)
```

Replace with:
```python
      - sources: comma list, e.g. "steamvr", "oculus,steamvr", or "pico"
      - ip:      optional IP for network ADB (oculus only; ignored by pico/steamvr)
```

- [ ] **Step 2: Verify nothing broke**

Run: `cd backend && python -c "import app.api.routes"`
Expected: no output, exit 0 (module imports cleanly)

- [ ] **Step 3: Commit**

```bash
git add backend/app/api/routes.py
git commit -m "docs: note pico in poses/stream docstring"
```

---

## Task 5: Packaging — submodule + optional-deps entry

**Files:**
- Modify: `.gitmodules` (via `git submodule add`)
- Modify: `backend/pyproject.toml:36-44` (optional-dependencies block)

- [ ] **Step 1: Add the pybind repo as a submodule**

Run (needs network):
```bash
git submodule add https://github.com/XR-Robotics/XRoboToolkit-PC-Service-Pybind.git third_party/XRoboToolkit-PC-Service-Pybind
```
Expected: clones into `third_party/XRoboToolkit-PC-Service-Pybind` and appends a stanza to `.gitmodules`.

- [ ] **Step 2: Add the `pico` optional-deps entry**

In `backend/pyproject.toml`, inside `[project.optional-dependencies]`, after the `oculus = [...]` line, add:

```toml
# PICO via XRoboToolkit. xrobotoolkit_sdk is NOT on PyPI — build it from the
# third_party/XRoboToolkit-PC-Service-Pybind submodule (see INSTALL.md) and
# install into this venv. The list is empty because there is no pip-resolvable
# requirement; the comment is the install contract.
pico = []
```

- [ ] **Step 3: Verify pyproject still parses**

Run: `cd backend && python -c "import tomllib; tomllib.load(open('pyproject.toml','rb')); print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add .gitmodules third_party/XRoboToolkit-PC-Service-Pybind backend/pyproject.toml
git commit -m "build: vendor XRoboToolkit pybind submodule + pico extra"
```

---

## Task 6: Hand-Eye tab — PICO tracker source

**Files:**
- Modify: `renderer/src/tabs/HandEyeTab.jsx:22-27` (TRACKER_SOURCES)
- Modify: `renderer/src/tabs/HandEyeTab.jsx:40-42` (state)
- Modify: `renderer/src/tabs/HandEyeTab.jsx:65-69` (trackerDeviceKey)
- Modify: `renderer/src/tabs/HandEyeTab.jsx` (source hint + device UI + connect gate)

- [ ] **Step 1: Add PICO to the source list**

In `renderer/src/tabs/HandEyeTab.jsx`, change `TRACKER_SOURCES`:

```javascript
const TRACKER_SOURCES = [
  { value: 'oculus',  label: 'Oculus Reader' },
  { value: 'pico',    label: 'PICO' },
  { value: 'ros2',    label: 'ROS2 topic' },
  { value: 'steamvr', label: 'SteamVR' },
  { value: 'file',    label: 'JSON file' },
];
```

- [ ] **Step 2: Add the picoDevice state**

After `const [oculusDevice, setOculusDevice] = useState('');` add:

```javascript
  const [picoDevice, setPicoDevice] = useState('');
```

- [ ] **Step 3: Extend trackerDeviceKey**

In `trackerDeviceKey`, add the pico branch before the final `return null;`:

```javascript
  const trackerDeviceKey = () => {
    if (trackerSource === 'oculus')  return oculusDevice || (kind === 'ctrl' ? 'controller_R' : 'hmd');
    if (trackerSource === 'pico')    return picoDevice || (kind === 'ctrl' ? 'pico_ctrl_r' : 'pico_hmd');
    if (trackerSource === 'steamvr') return steamvrSerial || (kind === 'ctrl' ? 'controller_R' : 'tracker_0');
    return null;
  };
```

- [ ] **Step 4: Add picoDevice to the connect callback deps**

Find the `onConnectTracker` `useCallback` dependency array `[trackerSource, oculusDevice, steamvrSerial, kind]` and add `picoDevice`:

```javascript
  }, [trackerSource, oculusDevice, picoDevice, steamvrSerial, kind]);
```

- [ ] **Step 5: Add the source-hint branch**

In the `Section title="Tracker source"` `hint={...}` expression, add a pico branch alongside oculus:

```javascript
            hint={
              trackerSource === 'file'    ? (posesPath ? basename(posesPath) : 'pick json') :
              trackerSource === 'oculus'  ? (oculusDevice || 'pick device') :
              trackerSource === 'pico'    ? (picoDevice || 'pick device') :
              trackerSource === 'ros2'    ? (trackerRos2Topic || 'pick topic') :
                                            (steamvrSerial || 'pick tracker')
            }
```

- [ ] **Step 6: Add the PICO device picker UI**

After the closing of the `{trackerSource === 'oculus' && ( ... )}` block, add:

```javascript
            {trackerSource === 'pico' && (
              <>
                <Field label="device">
                  <select className="select" value={picoDevice} disabled={connected}
                    onChange={e => setPicoDevice(e.target.value)}>
                    <option value="">— none —</option>
                    <option value="pico_ctrl_l">controller L</option>
                    <option value="pico_ctrl_r">controller R</option>
                    <option value="pico_hmd">headset</option>
                  </select>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                  via XRoboToolkit PC Service
                </div>
              </>
            )}
```

- [ ] **Step 7: Add pico to the connect-button gate**

Change the connect/disconnect block condition:

```javascript
            {(trackerSource === 'oculus' || trackerSource === 'pico' || trackerSource === 'steamvr') && (
```

- [ ] **Step 8: Verify the renderer builds**

Run: `cd /home/mi/Calibration && npm run build:renderer`
Expected: `✓ built` with no errors.

- [ ] **Step 9: Commit**

```bash
git add renderer/src/tabs/HandEyeTab.jsx
git commit -m "feat: add PICO tracker source to Hand-Eye tab"
```

---

## Task 7: Link tab — PICO slot backend

**Files:**
- Modify: `renderer/src/tabs/LinkCalibTab.jsx:700` (backend select)
- Modify: `renderer/src/tabs/_linkSlot.js:7` (comment)

- [ ] **Step 1: Add the PICO option to the slot backend select**

In `renderer/src/tabs/LinkCalibTab.jsx`, find the backend `<select>` options:

```javascript
              <option value="oculus">oculus (Quest3s)</option>
              <option value="steamvr">steamvr (Vive tracker)</option>
```

Add a pico option:

```javascript
              <option value="oculus">oculus (Quest3s)</option>
              <option value="pico">pico (XRoboToolkit)</option>
              <option value="steamvr">steamvr (Vive tracker)</option>
```

- [ ] **Step 2: Update the backend comment in _linkSlot.js**

In `renderer/src/tabs/_linkSlot.js`, change:

```javascript
  backend: 'steamvr',           // 'oculus' | 'steamvr'
```
to:
```javascript
  backend: 'steamvr',           // 'oculus' | 'pico' | 'steamvr'
```

- [ ] **Step 3: Verify the renderer builds**

Run: `cd /home/mi/Calibration && npm run build:renderer`
Expected: `✓ built` with no errors.

- [ ] **Step 4: Commit**

```bash
git add renderer/src/tabs/LinkCalibTab.jsx renderer/src/tabs/_linkSlot.js
git commit -m "feat: add PICO slot backend to Link tab"
```

---

## Task 8: INSTALL.md — PICO setup section

**Files:**
- Modify: `INSTALL.md`

- [ ] **Step 1: Append the PICO section**

Add to the end of `INSTALL.md`:

```markdown
## PICO tracker (XRoboToolkit)

PICO has no first-party Python pose SDK, so we use XRoboToolkit. `xrobotoolkit_sdk`
is **not on PyPI** — build it from source:

1. **Headset:** install the XRoboToolkit client APK on the PICO
   (`adb install <client>.apk`) and launch it.
2. **PC Service:** build and run `XRoboToolkit-PC-Service` (the daemon that
   receives poses from the headset). It is single-instance — start it before
   connecting from the Workbench.
3. **Python module:** build the vendored pybind module into the backend venv:
   ```bash
   cd third_party/XRoboToolkit-PC-Service-Pybind
   # copy PC-Service compiled libs/headers into lib/ and include/ per its README
   ../../backend/.venv/bin/python setup.py install
   ```
4. **Verify:** `backend/.venv/bin/python -c "import xrobotoolkit_sdk; xrobotoolkit_sdk.init(); print('ok')"`
   should print `ok` with the PC Service running.

In the app, pick **PICO** as the tracker source (Hand-Eye) or slot backend
(Link). Devices: `pico_ctrl_l`, `pico_ctrl_r`, `pico_hmd`. No adb-IP field is
needed — the PC Service owns the headset link.
```

- [ ] **Step 2: Commit**

```bash
git add INSTALL.md
git commit -m "docs: PICO setup instructions in INSTALL.md"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run the backend test suite**

Run: `cd backend && python -m pytest tests/test_pico_pose.py tests/test_pose_manager.py -v`
Expected: all pass.

- [ ] **Step 2: Lint the backend**

Run: `cd backend && ruff check app/sources/poses/pico.py app/sources/poses/manager.py`
Expected: no errors.

- [ ] **Step 3: Build the renderer**

Run: `cd /home/mi/Calibration && npm run build:renderer`
Expected: `✓ built`.

- [ ] **Step 4: Manual smoke (hardware, optional)**

With the PC Service running and the APK on the headset: select PICO in Hand-Eye
and Link, connect, and confirm the 3D scene tracks the controllers/HMD and the
Hz/staleness readouts update.

---

## Self-Review Notes

- **Spec coverage:** PicoPoseSource (Tasks 1–2), manager registration (Task 3),
  routes docstring (Task 4), submodule + extra (Task 5), Hand-Eye UI (Task 6),
  Link UI (Task 7), INSTALL docs (Task 8), error-handling table → covered by
  Task 2 tests (init failure, missing module, untracked skip). All spec sections
  map to a task.
- **No frame remapping** and **no daemon auto-spawn** remain non-goals — not
  implemented, by design.
- **Type/name consistency:** device IDs `pico_ctrl_l` / `pico_ctrl_r` / `pico_hmd`
  and the function names `_pose7_to_4x4`, `PicoPoseSource`, `_build_pico` are used
  identically across backend tasks and the renderer selectors.
