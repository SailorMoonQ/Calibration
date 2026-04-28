# Pinhole intrinsics parity — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `IntrinsicsTab` to feature parity with `FisheyeTab` — live raw/undistorted side-by-side preview driven by the calibration result, plus snap/drop/auto-capture/undo/keyboard-shortcuts.

**Architecture:** Extend the existing rectify endpoints (`/stream/mjpeg_rect`, `/dataset/rectified`) with a `model='pinhole'|'fisheye'` branch (default `'fisheye'` for back-compat). Pinhole uses `cv2.getOptimalNewCameraMatrix` + `cv2.initUndistortRectifyMap`/`cv2.undistort`; one `alpha` parameter replaces fisheye's `balance` + `fov_scale`. Renderer-side, the existing rectify components and URL builders take a `model` prop and pass it through. `IntrinsicsTab` is restructured to mirror `FisheyeTab`'s three-rail + split viewport layout, and the capture UX (drop, undo, auto-capture, keyboard shortcuts) is ported wholesale.

**Tech Stack:** FastAPI / OpenCV (backend), React 18 + Vite (renderer), pytest (backend tests).

**Spec:** `docs/superpowers/specs/2026-04-27-pinhole-parity-design.md`

---

## File Structure

| File | Role |
| --- | --- |
| `backend/app/api/routes.py` | Add `model='pinhole'` branch on `/stream/mjpeg_rect` and `/dataset/rectified`; rename `_fisheye_new_K` to `_new_K(model, …)` dispatch |
| `backend/tests/test_pinhole_rectify.py` (new) | `_new_K` math + endpoint dispatch + 400 on bogus model |
| `renderer/src/api/client.js` | `rectifiedMjpegUrl` / `fetchRectifiedBlob` accept `model` and `alpha` |
| `renderer/src/components/RectifiedLivePreview.jsx` | Forward `model` and `alpha` |
| `renderer/src/components/RectifiedFrame.jsx` | Forward `model` and `alpha` |
| `renderer/src/tabs/IntrinsicsTab.jsx` | Three-rail layout; alpha slider; split viewport with pinhole rectified preview; capture UX (drop, undo, auto-capture, keyboard) |

8 commits, no test infra changes (pytest already bootstrapped in `backend/tests/`).

---

### Task 1: Backend `_new_K` model dispatch + tests

Refactor the existing `_fisheye_new_K` helper into `_new_K(model, K, D, w, h, **kwargs)` that dispatches on model. Adds the pinhole branch using `cv2.getOptimalNewCameraMatrix` and clamps `alpha` to `[0, 1]`. Includes a degenerate-K fallback symmetric with the fisheye path.

**Files:**
- Modify: `backend/app/api/routes.py:269-291`
- Create: `backend/tests/test_pinhole_rectify.py`

- [ ] **Step 1: Write the failing tests for `_new_K`**

Create `backend/tests/test_pinhole_rectify.py`:

```python
"""Tests for the pinhole branch of the rectify helpers in app.api.routes."""
from __future__ import annotations

import numpy as np
import pytest

from app.api.routes import _new_K


def _synthetic_K(w=640, h=480, fx=500.0, fy=500.0):
    return np.array([[fx, 0.0, w / 2.0], [0.0, fy, h / 2.0], [0.0, 0.0, 1.0]], dtype=np.float64)


def _synthetic_D_pinhole(k1=-0.2, k2=0.05, p1=0.0, p2=0.0, k3=0.0):
    return np.array([k1, k2, p1, p2, k3], dtype=np.float64).reshape(-1, 1)


@pytest.mark.parametrize("alpha", [0.0, 0.5, 1.0])
def test_new_K_pinhole_returns_sane_matrix(alpha):
    K = _synthetic_K()
    D = _synthetic_D_pinhole()
    nK = _new_K("pinhole", K, D, 640, 480, alpha=alpha)
    assert nK.shape == (3, 3)
    assert nK[0, 0] > 0 and nK[1, 1] > 0
    # Principal point should land somewhere inside the image.
    assert 0 < nK[0, 2] < 640
    assert 0 < nK[1, 2] < 480


@pytest.mark.parametrize("alpha", [-1.0, 2.0, 1e9])
def test_new_K_pinhole_clamps_alpha(alpha):
    """Out-of-range alpha must not crash OpenCV — backend clamps to [0, 1]."""
    K = _synthetic_K()
    D = _synthetic_D_pinhole()
    nK = _new_K("pinhole", K, D, 640, 480, alpha=alpha)
    assert nK.shape == (3, 3)
    assert nK[0, 0] > 0 and nK[1, 1] > 0


def test_new_K_fisheye_unchanged():
    """Existing fisheye dispatch keeps producing a valid 3×3."""
    K = _synthetic_K()
    D = np.array([0.01, 0.0, 0.0, 0.0], dtype=np.float64).reshape(-1, 1)
    nK = _new_K("fisheye", K, D, 640, 480, balance=0.5, fov_scale=1.0)
    assert nK.shape == (3, 3)
    assert nK[0, 0] > 0 and nK[1, 1] > 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_pinhole_rectify.py -v
```

Expected: all four tests FAIL — `ImportError: cannot import name '_new_K' from 'app.api.routes'`.

- [ ] **Step 3: Implement `_new_K` dispatch**

In `backend/app/api/routes.py`, replace the existing `_fisheye_new_K` definition (lines 269-291) with:

```python
def _new_K(model: str, K: np.ndarray, D: np.ndarray, w: int, h: int, **kwargs) -> np.ndarray:
    """Pick the new camera matrix for rectification, dispatching by model.

    Each branch falls back to scaling K's own focal and recentring if the
    OpenCV estimator returns a degenerate matrix (fx<1 or fy<1) — keeps the
    rectified preview sensible even when the distortion vector is bad."""
    if model == "fisheye":
        balance = float(kwargs.get("balance", 0.5))
        fov_scale = float(kwargs.get("fov_scale", 1.0))
        try:
            nK = cv2.fisheye.estimateNewCameraMatrixForUndistortRectify(
                K, D, (w, h), np.eye(3), balance=balance, fov_scale=fov_scale,
            )
        except cv2.error:
            nK = None
        if nK is None or nK[0, 0] < 1.0 or nK[1, 1] < 1.0:
            nK = K.copy()
            nK[0, 0] *= fov_scale
            nK[1, 1] *= fov_scale
            nK[0, 2] = w / 2.0
            nK[1, 2] = h / 2.0
        return nK
    if model == "pinhole":
        alpha_raw = float(kwargs.get("alpha", 0.5))
        alpha = max(0.0, min(1.0, alpha_raw))
        try:
            nK, _roi = cv2.getOptimalNewCameraMatrix(K, D, (w, h), alpha)
        except cv2.error:
            nK = None
        if nK is None or nK[0, 0] < 1.0 or nK[1, 1] < 1.0:
            nK = K.copy()
            nK[0, 2] = w / 2.0
            nK[1, 2] = h / 2.0
        return np.asarray(nK, dtype=np.float64)
    raise ValueError(f"unknown model: {model!r}")


# Back-compat shim — old name still callable for any internal users.
def _fisheye_new_K(K, D, w, h, balance, fov_scale):
    return _new_K("fisheye", K, D, w, h, balance=balance, fov_scale=fov_scale)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_pinhole_rectify.py -v
```

Expected: all four tests PASS.

- [ ] **Step 5: Confirm existing tests still pass**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/ -v
```

Expected: full suite passes (the previous 3 pose-hello tests + 4 new pinhole tests = 7 PASSED).

- [ ] **Step 6: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/api/routes.py backend/tests/test_pinhole_rectify.py && git commit -m "feat(api): add pinhole branch to rectify helper (_new_K dispatch)"
```

---

### Task 2: `/stream/mjpeg_rect` accepts `model='pinhole'`

Add the pinhole branch to the live MJPEG rectify endpoint. Pinhole accepts
five extra query params (`p1, p2, k5, k6, alpha`) so the renderer can pass
the full distortion vector. `cv2.undistort` / `cv2.initUndistortRectifyMap`
(non-fisheye) replace the `cv2.fisheye.*` calls.

**Files:**
- Modify: `backend/app/api/routes.py:109-189`

- [ ] **Step 1: Update the endpoint signature and implementation**

In `backend/app/api/routes.py`, replace lines 109-189 with:

```python
@router.get("/stream/mjpeg_rect")
async def stream_mjpeg_rect(
    device: str,
    fx: float, fy: float, cx: float, cy: float,
    k1: float = 0.0, k2: float = 0.0, k3: float = 0.0, k4: float = 0.0,
    k5: float = 0.0, k6: float = 0.0,
    p1: float = 0.0, p2: float = 0.0,
    model: str = "fisheye",
    balance: float = 0.5, fov_scale: float = 1.0,
    alpha: float = 0.5,
    method: str = "remap",
    fps: int = 30, quality: int = 70,
):
    """Live-rectified MJPEG. `model='fisheye'` uses cv2.fisheye.* with k1..k4 +
    balance/fov_scale; `model='pinhole'` uses cv2.* (non-fisheye) with the full
    Brown-Conrady [k1, k2, p1, p2, k3, k4, k5, k6] vector + alpha. Maps are built
    once from the first frame's image_size; flip a query param to rebuild."""
    if method not in ("remap", "undistort"):
        raise HTTPException(status_code=400, detail=f"unknown method: {method}")
    if model not in ("fisheye", "pinhole"):
        raise HTTPException(status_code=400, detail=f"unknown model: {model}")
    src = source_manager.get(device)
    if not src.wait_frame(timeout=3.0):
        source_manager.release(device)
        raise HTTPException(status_code=503, detail="camera did not produce a frame")

    probe = src.read()
    if probe is None:
        source_manager.release(device)
        raise HTTPException(status_code=503, detail="no frame yet")
    h, w = probe.shape[:2]
    K = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float64)
    if model == "fisheye":
        D = np.array([k1, k2, k3, k4], dtype=np.float64).reshape(-1, 1)
        new_K = _new_K("fisheye", K, D, w, h, balance=balance, fov_scale=fov_scale)
    else:
        D = np.array([k1, k2, p1, p2, k3, k4, k5, k6], dtype=np.float64).reshape(-1, 1)
        new_K = _new_K("pinhole", K, D, w, h, alpha=alpha)

    try:
        if method == "remap":
            if model == "fisheye":
                map1, map2 = cv2.fisheye.initUndistortRectifyMap(
                    K, D, np.eye(3), new_K, (w, h), cv2.CV_16SC2,
                )
            else:
                map1, map2 = cv2.initUndistortRectifyMap(
                    K, D, np.eye(3), new_K, (w, h), cv2.CV_16SC2,
                )
    except cv2.error as e:
        source_manager.release(device)
        raise HTTPException(status_code=400, detail=f"rectify init failed: {e}")

    boundary = b"--frame"
    min_interval = 1.0 / max(1, fps)

    async def gen():
        last_seq = -1
        last_sent = 0.0
        try:
            while True:
                while src._latest_seq == last_seq:
                    await asyncio.sleep(0.003)
                now = time.time()
                if last_sent and now - last_sent < min_interval:
                    await asyncio.sleep(min_interval - (now - last_sent))
                frame = src.read()
                if frame is None:
                    continue
                last_seq = src._latest_seq
                if method == "remap":
                    rect = cv2.remap(frame, map1, map2,
                                     interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
                elif model == "fisheye":
                    rect = cv2.fisheye.undistortImage(frame, K, D, Knew=new_K, new_size=(w, h))
                else:
                    rect = cv2.undistort(frame, K, D, None, new_K)
                ok, buf = await asyncio.to_thread(
                    cv2.imencode, ".jpg", rect, [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
                )
                if not ok:
                    continue
                yield (
                    boundary + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(buf.size).encode() + b"\r\n\r\n"
                    + buf.tobytes() + b"\r\n"
                )
                last_sent = time.time()
        except asyncio.CancelledError:
            pass
        finally:
            source_manager.release(device)

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache, no-store, private", "Pragma": "no-cache"},
    )
```

- [ ] **Step 2: Smoke-test the endpoint with the running backend**

Start the backend in a separate process (use `Bash` `run_in_background=true`):

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m uvicorn app.main:app --port 8765
```

Then verify both branches return non-error responses (no actual camera needed for the
unknown-model path):

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8765/stream/mjpeg_rect?device=/dev/null&fx=500&fy=500&cx=320&cy=240&model=bogus"
```

Expected: prints `400` (unknown model rejected before camera open).

Stop the backend.

- [ ] **Step 3: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/api/routes.py && git commit -m "feat(api): pinhole model branch on /stream/mjpeg_rect"
```

---

### Task 3: `/dataset/rectified` accepts `model='pinhole'`

Same pattern, but on the POST endpoint that processes a single frame from
disk.

**Files:**
- Modify: `backend/app/api/routes.py:346-390`
- Modify: `backend/tests/test_pinhole_rectify.py` (add HTTP dispatch test)

- [ ] **Step 1: Add the dispatch test**

Append to `backend/tests/test_pinhole_rectify.py`:

```python
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_dataset_rectified_unknown_model_returns_400(client, tmp_path):
    img_path = tmp_path / "x.jpg"
    # Write a tiny valid JPEG so the path-existence check passes; the model
    # validation should fire before the image is decoded.
    import cv2
    img = np.zeros((8, 8, 3), dtype=np.uint8)
    cv2.imwrite(str(img_path), img)
    resp = client.post(
        "/dataset/rectified",
        json={
            "path": str(img_path),
            "K": [[500, 0, 4], [0, 500, 4], [0, 0, 1]],
            "D": [0.0, 0.0, 0.0, 0.0],
            "model": "bogus",
        },
    )
    assert resp.status_code == 400
    assert "unknown model" in resp.text.lower()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/test_pinhole_rectify.py::test_dataset_rectified_unknown_model_returns_400 -v
```

Expected: FAIL — the endpoint accepts the body without checking `model`.

- [ ] **Step 3: Update `/dataset/rectified` with the model branch**

In `backend/app/api/routes.py`, replace the `dataset_rectified` handler (lines 346-390) with:

```python
@router.post("/dataset/rectified")
async def dataset_rectified(body: dict):
    """Rectify the image at `path` with {K, D, model, ...params, method}.

    `model` selects the rectification family:
      - "fisheye" (default): cv2.fisheye.* with k1..k4 + balance/fov_scale.
      - "pinhole":           cv2.* (non-fisheye) with full Brown-Conrady D + alpha.
    `method` selects the implementation:
      - "remap"     (default): initUndistortRectifyMap + cv2.remap.
      - "undistort":           cv2.fisheye.undistortImage / cv2.undistort.
    Returns JPEG bytes.
    """
    path = body.get("path")
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="not found")
    try:
        K = np.array(body["K"], dtype=np.float64)
        D = np.array(body["D"], dtype=np.float64).reshape(-1, 1)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad K/D: {e}")
    model = (body.get("model") or "fisheye").lower()
    if model not in ("fisheye", "pinhole"):
        raise HTTPException(status_code=400, detail=f"unknown model: {model}")
    method = (body.get("method") or "remap").lower()
    if method not in ("remap", "undistort"):
        raise HTTPException(status_code=400, detail=f"unknown method: {method}")

    img = cv2.imread(path)
    if img is None:
        raise HTTPException(status_code=415, detail="cannot decode image")
    h, w = img.shape[:2]
    if model == "fisheye":
        balance = float(body.get("balance", 0.5))
        fov_scale = float(body.get("fov_scale", 1.0))
        new_K = _new_K("fisheye", K, D, w, h, balance=balance, fov_scale=fov_scale)
    else:
        alpha = float(body.get("alpha", 0.5))
        new_K = _new_K("pinhole", K, D, w, h, alpha=alpha)
    try:
        if method == "undistort":
            if model == "fisheye":
                rect = cv2.fisheye.undistortImage(img, K, D, Knew=new_K, new_size=(w, h))
            else:
                rect = cv2.undistort(img, K, D, None, new_K)
        else:
            if model == "fisheye":
                map1, map2 = cv2.fisheye.initUndistortRectifyMap(
                    K, D, np.eye(3), new_K, (w, h), cv2.CV_16SC2,
                )
            else:
                map1, map2 = cv2.initUndistortRectifyMap(
                    K, D, np.eye(3), new_K, (w, h), cv2.CV_16SC2,
                )
            rect = cv2.remap(img, map1, map2, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    except cv2.error as e:
        raise HTTPException(status_code=500, detail=f"rectify failed: {e}")

    ok, buf = cv2.imencode(".jpg", rect, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise HTTPException(status_code=500, detail="encode failed")
    return Response(content=buf.tobytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "no-cache, no-store"})
```

- [ ] **Step 4: Run all backend tests**

```bash
cd /home/mi/Calibration/backend && PYTHONPATH="" .venv/bin/python -m pytest tests/ -v
```

Expected: all tests PASS (3 pose-hello + 4 _new_K + 1 dispatch = 8 PASSED).

- [ ] **Step 5: Commit**

```bash
cd /home/mi/Calibration && git add backend/app/api/routes.py backend/tests/test_pinhole_rectify.py && git commit -m "feat(api): pinhole model branch on /dataset/rectified"
```

---

### Task 4: Renderer URL builders accept `model` and `alpha`

`rectifiedMjpegUrl` and `fetchRectifiedBlob` get a `model` field (default
`'fisheye'`). Pinhole calls supply `alpha` plus the full Brown-Conrady D; the
function maps them to query/body fields the backend expects.

**Files:**
- Modify: `renderer/src/api/client.js:55-69` (rectifiedMjpegUrl), `109-122` (fetchRectifiedBlob)

- [ ] **Step 1: Update `rectifiedMjpegUrl`**

In `renderer/src/api/client.js`, replace the `rectifiedMjpegUrl` function with:

```js
// Live-undistorted MJPEG. `model='fisheye'` (default, K/D = 3x3 + [k1..k4],
// balance + fov_scale) or `model='pinhole'` (K/D = 3x3 + Brown-Conrady up to
// 8 elements, alpha). Cache-bust `t` ensures intrinsics changes reopen the stream.
export async function rectifiedMjpegUrl(device, {
  K, D,
  model = 'fisheye',
  balance = 0.5, fov_scale = 1.0,
  alpha = 0.5,
  method = 'remap', fps = 15, quality = 80,
} = {}) {
  const { baseUrl } = await info();
  const qs = new URLSearchParams({
    device,
    fx: String(K[0][0]), fy: String(K[1][1]), cx: String(K[0][2]), cy: String(K[1][2]),
    model, method,
    fps: String(fps), quality: String(quality),
    t: String(Date.now()),
  });
  if (model === 'fisheye') {
    qs.set('k1', String(D[0] ?? 0));
    qs.set('k2', String(D[1] ?? 0));
    qs.set('k3', String(D[2] ?? 0));
    qs.set('k4', String(D[3] ?? 0));
    qs.set('balance', String(balance));
    qs.set('fov_scale', String(fov_scale));
  } else {
    // Brown-Conrady: D = [k1, k2, p1, p2, k3, k4, k5, k6] (last four optional, default 0).
    qs.set('k1', String(D[0] ?? 0));
    qs.set('k2', String(D[1] ?? 0));
    qs.set('p1', String(D[2] ?? 0));
    qs.set('p2', String(D[3] ?? 0));
    qs.set('k3', String(D[4] ?? 0));
    qs.set('k4', String(D[5] ?? 0));
    qs.set('k5', String(D[6] ?? 0));
    qs.set('k6', String(D[7] ?? 0));
    qs.set('alpha', String(alpha));
  }
  return `${baseUrl}/stream/mjpeg_rect?${qs.toString()}`;
}
```

- [ ] **Step 2: Update `fetchRectifiedBlob`**

In the same file, replace `fetchRectifiedBlob` with:

```js
export async function fetchRectifiedBlob({
  path, K, D,
  model = 'fisheye',
  balance = 0.5, fov_scale = 1.0,
  alpha = 0.5,
  method = 'remap',
}) {
  const { baseUrl } = await info();
  const body = { path, K, D, model, method };
  if (model === 'fisheye') {
    body.balance = balance;
    body.fov_scale = fov_scale;
  } else {
    body.alpha = alpha;
  }
  const res = await fetch(`${baseUrl}/dataset/rectified`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`rectify ${res.status}: ${txt}`);
  }
  return res.blob();
}
```

- [ ] **Step 3: Verify the renderer still builds**

```bash
cd /home/mi/Calibration && npm run build:renderer
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/api/client.js && git commit -m "feat(api-client): URL builders accept model + alpha for pinhole rectify"
```

---

### Task 5: `RectifiedLivePreview` and `RectifiedFrame` accept `model` + `alpha`

Components themselves are URL→`<img>` thin wrappers; they just need to
forward the new props.

**Files:**
- Modify: `renderer/src/components/RectifiedLivePreview.jsx`
- Modify: `renderer/src/components/RectifiedFrame.jsx`

- [ ] **Step 1: Update `RectifiedLivePreview.jsx`**

Replace the entire contents of `renderer/src/components/RectifiedLivePreview.jsx` with:

```jsx
import React, { useEffect, useState } from 'react';
import { rectifiedMjpegUrl } from '../api/client.js';

// Live MJPEG stream undistorted on the backend. <img> handles the multipart frames;
// when K/D/model/(balance|fovScale|alpha)/method change we generate a new URL
// (with cache-bust) so the stream reopens with fresh maps.
export function RectifiedLivePreview({
  device, K, D,
  model = 'fisheye',
  balance = 0.5, fovScale = 1.0,
  alpha = 0.5,
  method = 'remap', fps = 15, quality = 75,
}) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);

  // Stable deps — K/D arrays change identity each render even when values are the same.
  const kKey = K ? JSON.stringify(K) : '';
  const dKey = D ? JSON.stringify(D) : '';

  useEffect(() => {
    if (!device || !K || !D || !D.length) { setUrl(null); return; }
    let cancelled = false;
    setErr(null);
    rectifiedMjpegUrl(device, {
      K, D, model,
      balance, fov_scale: fovScale,
      alpha,
      method, fps, quality,
    })
      .then(u => { if (!cancelled) setUrl(u); })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [device, kKey, dKey, model, balance, fovScale, alpha, method, fps, quality]);

  const placeholder = (text, color = 'var(--view-text-2)') => (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      width:'100%', height:'100%', color,
      fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign: 'center',
    }}>{text}</div>
  );

  if (err) return placeholder(err, 'var(--err)');
  if (!device) return placeholder('pick a camera to rectify');
  if (!K || !D || !D.length) return placeholder('run calibration to see the rectified view');
  if (!url) return placeholder('starting…');
  return <img src={url} alt={`rectified ${device}`}
              style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }}/>;
}
```

- [ ] **Step 2: Update `RectifiedFrame.jsx`**

Replace the entire contents of `renderer/src/components/RectifiedFrame.jsx` with:

```jsx
import React, { useEffect, useState } from 'react';
import { fetchRectifiedBlob } from '../api/client.js';

export function RectifiedFrame({
  path, K, D,
  model = 'fisheye',
  balance = 0.5, fovScale = 1.0,
  alpha = 0.5,
  method = 'remap',
}) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);

  // Stable deps for the effect: K and D are arrays and change identity each render,
  // so key off their content.
  const kKey = K ? JSON.stringify(K) : '';
  const dKey = D ? JSON.stringify(D) : '';

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;
    if (!path || !K || !D) { setUrl(null); return; }
    setErr(null);
    fetchRectifiedBlob({ path, K, D, model, balance, fov_scale: fovScale, alpha, method })
      .then(blob => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(e => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, kKey, dKey, model, balance, fovScale, alpha, method]);

  if (err) {
    return (
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', height:'100%', color:'var(--err)',
        fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign: 'center',
      }}>{err}</div>
    );
  }
  if (!path || !K || !D) {
    return (
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', height:'100%', color:'var(--view-text-2)',
        fontFamily:'JetBrains Mono', fontSize: 11,
      }}>calibrate to see the rectified view</div>
    );
  }
  if (!url) {
    return (
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', height:'100%', color:'var(--view-text-2)',
        fontFamily:'JetBrains Mono', fontSize: 11,
      }}>rectifying…</div>
    );
  }
  return <img src={url} alt="rectified"
              style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }}/>;
}
```

- [ ] **Step 3: Verify the renderer builds**

```bash
cd /home/mi/Calibration && npm run build:renderer
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/components/RectifiedLivePreview.jsx renderer/src/components/RectifiedFrame.jsx && git commit -m "feat(components): rectify components accept model + alpha"
```

---

### Task 6: IntrinsicsTab — split viewport with pinhole rectify

Restructure `IntrinsicsTab.jsx` to mirror `FisheyeTab`'s layout: alpha
slider in the rail, view-mode segment (`split | raw | rect`), method
toggle (`remap | undistort`), and a viewport that splits into raw +
rectified cells once the calibration converges.

**Files:**
- Modify: `renderer/src/tabs/IntrinsicsTab.jsx`

- [ ] **Step 1: Add new state and the rectified cell**

This task is large enough that we make all the structural changes in
one commit. Read the existing file first:

```bash
cat /home/mi/Calibration/renderer/src/tabs/IntrinsicsTab.jsx
```

Then apply these edits (concise change list — each location is exact):

(a) Replace the imports block (lines 1-11) with:

```jsx
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Section, Seg, Chk, Field, Matrix } from '../components/primitives.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { RectifiedFrame } from '../components/RectifiedFrame.jsx';
import { RectifiedLivePreview } from '../components/RectifiedLivePreview.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { LiveDetectedFrame } from '../components/LiveDetectedFrame.jsx';
import {
  FrameStrip, ErrorPanel, SourcePanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
} from '../components/panels.jsx';
import { computeCoverage, cellIndexFor } from '../lib/coverage.js';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';
```

(b) Inside the component body, replace the local-state block (currently
the existing `useState`s on lines 16-35) with this version. The deltas
are: `view` and `method` added; the unused `overlay` is replaced by a
`showResid` checkbox; `showOrigin` stays; `alpha` added; static
checkbox `model` stays as the projection model (unchanged):

```jsx
  const [board, setBoard] = useState({ type: 'chess', cols: 11, rows: 8, sq: 0.045 });
  const [live, setLive] = useState(true);
  const [device, setDevice] = useState('/dev/video0 · Basler acA1920');
  const [bagPath, setBagPath] = useState('');
  const [autoCapture, setAuto] = useState(false);
  const [view, setView] = useState('split');                 // 'split' | 'raw' | 'rect'
  const [method, setMethod] = useState('remap');             // 'remap' | 'undistort'
  const [alpha, setAlpha] = useState(0.5);
  const [showBoard, setShowBoard] = useState(true);
  const [showResid, setShowResid] = useState(true);
  const [showOrigin, setShowOrigin] = useState(true);
  const [model, setModel] = useState('pinhole-k3');

  const [datasetPath, setDatasetPath] = useState('');
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const [devices, setDevices] = useState([]);
  const [liveDevice, setLiveDevice] = useState('');
  const [viewMode, setViewMode] = useState('live');          // 'live' | 'frame'
  const [liveDetect, setLiveDetect] = useState(false);
```

(c) After the existing `coverage = useMemo(...)` block (around line 55), unchanged.

(d) After `const D = result?.D ?? [];` (currently line 71), add:

```jsx
  const calibrated = !!(result?.ok && result?.K && D.length);
  const selectedPath = datasetFiles[selectedFrame - 1];
  const canRectifyFrame = !!(calibrated && selectedPath);
  const showLive = liveDevice && (viewMode === 'live' || datasetFiles.length === 0);
```

(e) Replace the entire JSX returned by the component (currently lines
201-343) with the FisheyeTab-style three-rail + split-viewport layout.
Drop the dead static checkboxes from the Model section (`estimate skew`,
`fix aspect`, `bundle adjust`, `robust loss`); keep the `Seg` for
projection model. Replace the single-cell viewport with two cells
(`rawCell`, `rectifiedCell`) selected by `view`. New JSX:

```jsx
  const emptyCell = (text) => (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      width:'100%', height:'100%', color:'var(--view-text-2)',
      fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign:'center',
    }}>{text}</div>
  );

  const rawCell = (
    <div className="vp-cell" key="raw">
      <span className="vp-label">
        {showLive ? `live · ${liveDevice}${liveDetect ? ' · detect' : ''}` : 'raw'}
      </span>
      {showLive ? (
        liveDetect
          ? <LiveDetectedFrame device={liveDevice} board={board}
                showCorners={showBoard} showOrigin={showOrigin}
                onMeta={onAutoMeta}/>
          : <LivePreview device={liveDevice}/>
      ) : datasetFiles.length > 0 && selectedPath ? (
        <DetectedFrame
          path={selectedPath}
          board={board}
          showCorners={showBoard}
          showOrigin={showOrigin}
          overlay={showResid ? 'residuals' : 'none'}
          residuals={residualsByPath?.get(selectedPath)}/>
      ) : (
        emptyCell('connect a camera or load a dataset')
      )}
      <div className="vp-corner-read">
        <div>fx <b>{K[0][0].toFixed(2)}</b>  fy <b>{K[1][1].toFixed(2)}</b></div>
        <div>cx <b>{K[0][2].toFixed(2)}</b>  cy <b>{K[1][2].toFixed(2)}</b></div>
        <div>k₁ <b>{(D[0] ?? 0).toFixed(3)}</b>  k₂ <b>{(D[1] ?? 0).toFixed(3)}</b></div>
        <div>p₁ <b>{(D[2] ?? 0).toFixed(4)}</b>  p₂ <b>{(D[3] ?? 0).toFixed(4)}</b></div>
      </div>
    </div>
  );

  const rectCell = (() => {
    const useLive = showLive && calibrated && liveDevice;
    let body;
    if (useLive) {
      body = <RectifiedLivePreview device={liveDevice} K={result.K} D={D}
                model="pinhole" alpha={alpha} method={method}/>;
    } else if (canRectifyFrame) {
      body = <RectifiedFrame path={selectedPath} K={result.K} D={D}
                model="pinhole" alpha={alpha} method={method}/>;
    } else if (calibrated) {
      body = emptyCell('connect a camera or select a frame to see the undistorted view');
    } else {
      body = emptyCell('run calibration to see the undistorted view');
    }
    return (
      <div className="vp-cell" key="rect">
        <span className="vp-label">{useLive ? `undistorted · live` : 'undistorted'}</span>
        {body}
        <div className="vp-corner-read">
          <div>method <b>{method === 'undistort' ? 'cv2.undistort' : 'initUndistortRectifyMap + remap'}</b></div>
          <div>alpha <b>{alpha.toFixed(2)}</b></div>
        </div>
      </div>
    );
  })();

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header"><span>Pinhole Intrinsics</span><button className="btn sm ghost">⛶</button></div>
        <div className="rail-scroll">
          <SourcePanel live={live} onLive={setLive} device={device} onDevice={setDevice} bagPath={bagPath} onBagPath={setBagPath}/>
          <Section title="Live camera" hint={liveDevice || 'no device'}>
            <Field label="device">
              <select className="select" value={liveDevice} onChange={e => setLiveDevice(e.target.value)}>
                <option value="">— none —</option>
                {devices.map(d => <option key={d.device} value={d.device}>{d.label}</option>)}
              </select>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={() => setViewMode('live')}>👁 live preview</button>
              <button className="btn ghost" onClick={() => api.listStreamDevices().then(r => setDevices(r.cameras || []))}>↻ rescan</button>
            </div>
          </Section>
          <Section title="Dataset" hint={datasetFiles.length ? `${datasetFiles.length} images` : 'not loaded'}>
            <Field label="folder">
              <input className="input" value={datasetPath} placeholder="/path/to/frames/"
                     onChange={e => setDatasetPath(e.target.value)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={onPickFolder}>📁 pick folder</button>
              <button className="btn ghost" onClick={() => { setDatasetPath(''); setDatasetFiles([]); setResult(null); setStatus(''); }}>clear</button>
            </div>
            {status && <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)', marginTop: 2 }}>{status}</div>}
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title="Model" hint={model}>
            <Seg value={model} onChange={setModel} full options={[
              {value:'pinhole-k3',label:'k3'},{value:'pinhole-k5',label:'k5'},{value:'pinhole-rt',label:'rational'}
            ]}/>
          </Section>
          <Section title="Undistortion preview">
            <Field label="alpha">
              <div className="slider-row">
                <input type="range" min="0" max="100" value={Math.round(alpha * 100)}
                       onChange={e => setAlpha(+e.target.value / 100)}/>
                <span className="mono">{alpha.toFixed(2)}</span>
              </div>
            </Field>
          </Section>
          <CaptureControls live={live} onLive={setLive}
            autoCapture={autoCapture}
            onAuto={(v) => { setAuto(v); if (v) setLiveDetect(true); }}
            onSnap={onSnap} onDrop={onDrop}
            coverage={coverage.percent} coverageCells={coverage.cells}/>
        </div>
        <SolverButton onSolve={onRun} busy={busy}
          status={status}
          statusKind={
            !status ? undefined :
            /^failed|error|cannot|did not|need ≥|too many|pick |snap failed|listing failed|save failed|load failed/i.test(status) ? 'err' :
            result?.ok ? 'ok' : 'warn'
          }/>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value={view} onChange={setView} options={[
            {value:'split',label:'split'},{value:'raw',label:'raw'},{value:'rect',label:'rectified'},
          ]}/>
          {view !== 'raw' && (
            <Seg value={method} onChange={setMethod} options={[
              {value:'remap',label:'remap'},{value:'undistort',label:'undistort'},
            ]}/>
          )}
          <Chk checked={showBoard} onChange={setShowBoard}>board</Chk>
          <Chk checked={showOrigin} onChange={setShowOrigin}>origin</Chk>
          <Chk checked={showResid} onChange={setShowResid}>residuals</Chk>
          <Chk checked={liveDetect} onChange={setLiveDetect}>detect live</Chk>
          <div className="spacer"/>
          <div className="read">
            {datasetFiles.length > 0 && <>frame <b>#{selectedFrame.toString().padStart(2,'0')}</b> · </>}
            {result?.ok
              ? <>rms <b>{rms.toFixed(3)}</b> px</>
              : busy ? <>solving…</> : <>not calibrated</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selectedFrame} onSelect={(id) => { setSelected(id); setViewMode('frame'); }} coverage={coverage.percent}/>
        {(() => {
          let cells;
          if (!calibrated) {
            cells = [rawCell];
          } else if (view === 'raw') {
            cells = [rawCell];
          } else if (view === 'rect') {
            cells = [rectCell];
          } else {
            cells = [rawCell, rectCell];
          }
          const cols = cells.length === 2 ? '1fr 1fr' : '1fr';
          return (
            <div className="vp-body vp-split" style={{ gridTemplateColumns: cols }}>
              {cells}
            </div>
          );
        })()}
      </div>

      <div className="rail">
        <div className="rail-header">
          <span>Results</span>
          <span className="mono" style={{color: converged ? 'var(--ok)' : 'var(--text-4)'}}>
            {converged ? '● converged' : busy ? '● solving' : '○ idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <ErrorPanel rms={rms} frames={sparkData} histData={histData}/>
          <Section title="Intrinsic matrix K">
            <Matrix m={K}/>
          </Section>
          <Section title="Distortion" hint="k₁ k₂ p₁ p₂ k₃…">
            <div className="mono" style={{ fontSize: 11.5, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
              {D.slice(0, 8).map((v, i) => (
                <React.Fragment key={i}>
                  <span style={{color:'var(--text-3)'}}>{['k₁','k₂','p₁','p₂','k₃','k₄','k₅','k₆'][i] ?? `d${i}`}</span>
                  <span style={{textAlign:'right'}}>{v.toFixed(5)}</span>
                </React.Fragment>
              ))}
            </div>
          </Section>
          <SolverPanel
            iters={result?.iterations ?? 0}
            cost={result?.final_cost ?? 0}
            cond={0}/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display:'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoad}>↓ load</button>
          <button className="btn primary" style={{flex:1}} onClick={onSave} disabled={!result?.ok}>↑ save</button>
        </div>
      </div>
    </div>
  );
}
```

(f) Add stub handlers `onDrop` and `onAutoMeta` near the existing
`onSnap` so the JSX above compiles without ReferenceErrors. These will
be filled in by Task 7. For now:

```jsx
  const onDrop = useCallback(() => { /* wired in Task 7 */ }, []);
  const onAutoMeta = useCallback(() => { /* wired in Task 7 */ }, []);
```

- [ ] **Step 2: Verify the renderer builds**

```bash
cd /home/mi/Calibration && npm run build:renderer
```

Expected: build succeeds. (The new viewport renders a stub `onDrop`/`onAutoMeta`; capture-side wiring lands in the next task.)

- [ ] **Step 3: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/tabs/IntrinsicsTab.jsx && git commit -m "feat(intrinsics): split viewport + pinhole undistort preview"
```

---

### Task 7: IntrinsicsTab — capture UX (drop, undo, auto-capture, keyboard)

Replace the stub `onDrop` / `onAutoMeta` with real implementations and add
the undo stack, the keyboard listener, and the auto-capture state. Direct
mirror of `FisheyeTab`'s code shapes.

**Files:**
- Modify: `renderer/src/tabs/IntrinsicsTab.jsx`

- [ ] **Step 1: Add the undo stack, auto-capture refs, and keyboard listener**

In `renderer/src/tabs/IntrinsicsTab.jsx`, near the other refs (after the
existing `useState`s and before the existing `onPickFolder`), add:

```jsx
  // Refs the global keydown handler reads from so it always sees fresh closures
  // without re-attaching the listener on every render.
  const onSnapRef = useRef(null);
  const onUndoRef = useRef(null);
  const datasetCountRef = useRef(0);
  useEffect(() => { datasetCountRef.current = datasetFiles.length; }, [datasetFiles.length]);

  // Bounded undo stack of {kind: 'snap'|'drop', path, trashPath?}.
  const UNDO_LIMIT = 20;
  const undoStackRef = useRef([]);
  const pushUndo = (entry) => {
    const stack = undoStackRef.current;
    stack.push(entry);
    if (stack.length > UNDO_LIMIT) stack.shift();
  };

  // Auto-capture state: claimed coverage cells (so we don't spam) + debounce + inflight gate.
  const snappedCellsRef = useRef(new Set());
  const lastAutoSnapRef = useRef(0);
  const autoSnapInFlightRef = useRef(false);
  useEffect(() => { snappedCellsRef.current = new Set(); }, [datasetPath]);
```

- [ ] **Step 2: Implement `onDrop`**

Replace the stub `const onDrop = useCallback(() => { /* wired in Task 7 */ }, []);`
with:

```jsx
  const onDrop = async () => {
    const path = datasetFiles[selectedFrame - 1];
    if (!path) { setStatus('no frame selected to drop'); return; }
    const name = path.split('/').pop();
    try {
      const r = await api.deleteFrame(path);
      pushUndo({ kind: 'drop', path, trashPath: r.trash_path });
      const files = await refreshDataset();
      const newLen = files?.length ?? 0;
      setSelected(Math.min(Math.max(1, selectedFrame), Math.max(1, newLen)));
      if (newLen === 0) setViewMode('live');
      setStatus(`dropped ${name} · ⌘Z to undo`);
    } catch (e) { setStatus(`drop failed: ${e.message}`); }
  };
```

- [ ] **Step 3: Implement `onAutoMeta`**

Replace the stub `const onAutoMeta = useCallback(() => { /* wired in Task 7 */ }, []);`
with the real callback (must be a `useCallback` so `LiveDetectedFrame.onMeta` doesn't re-bind on every render):

```jsx
  const onAutoMeta = useCallback((meta) => {
    if (!autoCapture || !liveDevice || !datasetPath) return;
    const corners = meta?.corners;
    const size = meta?.image_size;
    if (!corners || corners.length < 4 || !size) return;
    const now = performance.now();
    if (now - lastAutoSnapRef.current < 500) return;
    if (autoSnapInFlightRef.current) return;
    let sx = 0, sy = 0;
    for (const c of corners) { sx += c[0]; sy += c[1]; }
    const cx = sx / corners.length, cy = sy / corners.length;
    const idx = cellIndexFor(cx, cy, size);
    if (idx == null) return;
    if (snappedCellsRef.current.has(idx)) return;
    autoSnapInFlightRef.current = true;
    lastAutoSnapRef.current = now;
    snappedCellsRef.current.add(idx);
    (async () => {
      try {
        const r = await api.snap(liveDevice, datasetPath);
        pushUndo({ kind: 'snap', path: r.path });
        setStatus(`auto-snapped → ${r.path.split('/').pop()} (cell ${idx})`);
        const files = await refreshDataset();
        if (files) setSelected(files.length);
      } catch (e) {
        snappedCellsRef.current.delete(idx);
        setStatus(`auto-snap failed: ${e.message}`);
      } finally {
        autoSnapInFlightRef.current = false;
      }
    })();
  }, [autoCapture, liveDevice, datasetPath]);
```

- [ ] **Step 4: Add `onUndo` and update `onSnap` to push to the undo stack**

Locate the existing `onSnap` function (currently around line 109) and
replace it with an extended version plus a new `onUndo`:

```jsx
  const onSnap = async () => {
    let dir = datasetPath;
    if (!dir) {
      const picked = await pickFolder();
      if (!picked) { setStatus('pick a session folder before snapping'); return; }
      setDatasetPath(picked);
      dir = picked;
    }
    if (!liveDevice) { setStatus('pick a camera first'); return; }
    try {
      const r = await api.snap(liveDevice, dir);
      pushUndo({ kind: 'snap', path: r.path });
      setStatus(`snapped → ${r.path.split('/').pop()} · ⌘Z to undo`);
      if (dir === datasetPath) {
        const files = await refreshDataset();
        if (files) { setSelected(files.length); setViewMode('frame'); }
      }
    } catch (e) { setStatus(`snap failed: ${e.message}`); }
  };

  const onUndo = async () => {
    const stack = undoStackRef.current;
    if (!stack.length) { setStatus('nothing to undo'); return; }
    const entry = stack.pop();
    try {
      if (entry.kind === 'snap') {
        await api.deleteFrame(entry.path);
        await refreshDataset();
        setStatus(`undid snap · ${entry.path.split('/').pop()}`);
      } else if (entry.kind === 'drop') {
        await api.restoreFrame(entry.trashPath, entry.path);
        await refreshDataset();
        setStatus(`undid drop · ${entry.path.split('/').pop()}`);
      }
    } catch (e) {
      stack.push(entry);
      setStatus(`undo failed: ${e.message}`);
    }
  };

  // Keep refs pointed at the latest closures so the keydown handler always sees fresh.
  useEffect(() => { onSnapRef.current = onSnap; });
  useEffect(() => { onUndoRef.current = onUndo; });
```

- [ ] **Step 5: Add the global keyboard listener**

After the ref-keepers above, add:

```jsx
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || t?.isContentEditable) {
        return;
      }
      if (e.key === 'ArrowRight') {
        if (datasetCountRef.current === 0) return;
        e.preventDefault();
        setSelected(s => Math.min(datasetCountRef.current, s + 1));
        setViewMode('frame');
      } else if (e.key === 'ArrowLeft') {
        if (datasetCountRef.current === 0) return;
        e.preventDefault();
        setSelected(s => Math.max(1, s - 1));
        setViewMode('frame');
      } else if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        onSnapRef.current?.();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        onUndoRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
```

- [ ] **Step 6: Verify the renderer builds**

```bash
cd /home/mi/Calibration && npm run build:renderer
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /home/mi/Calibration && git add renderer/src/tabs/IntrinsicsTab.jsx && git commit -m "feat(intrinsics): drop, undo, auto-capture, keyboard shortcuts"
```

---

### Task 8: End-to-end manual verification

The implementation is complete; this task walks the spec's manual test plan
to flush out any regressions a build-time check missed.

- [ ] **Step 1: Run the app**

```bash
cd /home/mi/Calibration && npm run dev
```

- [ ] **Step 2: Walk the test plan**

For each of the seven items in the spec's "Manual test plan" section
(`docs/superpowers/specs/2026-04-27-pinhole-parity-design.md`):

1. Calibrate IntrinsicsTab → raw and rectified cells render side-by-side in `split` view.
2. Slide `alpha` 0 → 1 → rectified view recrops live.
3. Toggle `method` `remap` / `undistort` → output looks identical.
4. Snap with `Space`; ⌘Z deletes the just-snapped file.
5. Drop a bad frame; ⌘Z restores it.
6. Auto-capture on, sweep the board across the FOV → snaps fire only on newly-covered cells, no spam.
7. FisheyeTab regression — open it, run a normal flow: behaviour unchanged.

For any failure, fix in the affected task's files and recommit.

- [ ] **Step 3: Stop the app**

Ctrl-C the dev server.
