# 针孔标定页对齐鱼眼页采集能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `FisheyeTab`（Tab2 鱼眼）相对 `IntrinsicsTab`（Tab1 针孔）多出的全部采集能力落到针孔页，依赖鱼眼图像圆的几何改写为针孔适用的矩形形式。

**Architecture:** 把「圆」抽象成「extent `{cx,cy,rx,ry}`」（鱼眼 `rx===ry`，泛化后数值不变）；把自动拍摄状态机抽成 `useSmartCapture` hook，几何差异由适配器（极坐标 / 矩形）注入；两个 Tab 共用同一份状态机。

**Tech Stack:** React 18（函数组件 + hooks）、Vite 6、i18next、Canvas 2D、Node 20 内置 `node --test`。无新增依赖。

## Global Constraints

- 只改 `renderer/`、`package.json`、`.github/workflows/ci.yml`。**不改 `backend/`**。
- **不移植** Save 时写入机器人 `camera_intrix.yaml` 的机位导出（后端把 `distortion_model` 硬编码为 `"fisheye"`）。
- **鱼眼行为必须不变**：泛化后凡原先用 `circle.r` 处取 `rx`/`ry`/`min(rx,ry)`，在 `rx===ry` 时逐点等价。Task 4 有专门的回归断言。
- 测试只 import 纯 `.js` 模块，**不得 import `.jsx`**（无转译环境）。
- 每加/改一个 i18n 键，`en.json` 与 `zh.json` 必须同步；`npm run i18n:check` 会卡住漏键。
- 提交身份由本仓库局部 git config 决定（`SailorMoonQ <dongwenquan3610@gmail.com>`），提交信息里**不得**出现任何其他邮箱或 "Generated with Claude Code" 之类的署名行。
- ESLint 配置在 `.config/lint.cjs`；`renderer/src/**` 按浏览器全局 + `no-unused-vars`（`^_` 前缀豁免）检查。每个任务结束前 `npm run lint` 必须干净。

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `renderer/src/lib/boardMetrics.js` | 从角点算板的几何量（质心/倾角/滚转/尺度），不知道相机模型 |
| `renderer/src/lib/boardMetrics.test.js` | 上者的测试 |
| `renderer/src/lib/guidedSequence.test.js` | 引导序列的测试（含 extent 回归断言） |
| `renderer/src/lib/coverage.test.js` | 矩形网格新增导出的测试 |
| `renderer/src/lib/smartCapture/geometry.js` | 两个几何适配器工厂 |
| `renderer/src/lib/smartCapture/geometry.test.js` | 适配器测试 |
| `renderer/src/lib/smartCapture/useSmartCapture.js` | 自动拍摄状态机（唯一一份） |

**修改**

| 文件 | 改动 |
|---|---|
| `renderer/src/lib/polarCoverage.js` | 移出 `boardTiltDeg` |
| `renderer/src/lib/coverage.js` | 补 `cellGeometry` / `pickGuidanceCell` |
| `renderer/src/lib/guidedSequence.js` | 泛化到 extent + profile；迁入 `targetHalfSize` |
| `renderer/src/components/LiveDetectedFrame.jsx` | 新增 `guidedExtent` prop；引导叠加走 extent |
| `renderer/src/components/panels.jsx` | `CoverageGrid` 支持 `guidance` 高亮 |
| `renderer/src/tabs/FisheyeTab.jsx` | 状态机替换为 `useSmartCapture` |
| `renderer/src/tabs/IntrinsicsTab.jsx` | 接入全部新能力 |
| `renderer/src/i18n/en.json` / `zh.json` | `guided.*` 提升到顶层；`intrinsics.*` 补键 |
| `package.json` | 加 `test` 脚本 |
| `.github/workflows/ci.yml` | renderer job 加 `npm test` |

---

### Task 1: 测试基础设施 + `boardMetrics.js`

把几何中立的板测量从 `polarCoverage.js` / `guidedSequence.js` 抽出来，并把 `boardScale` 泛化到 extent。同时把 `node --test` 接进 npm 与 CI —— 后续所有任务都靠它。

**Files:**
- Create: `renderer/src/lib/boardMetrics.js`
- Create: `renderer/src/lib/boardMetrics.test.js`
- Modify: `renderer/src/lib/polarCoverage.js`（删除 `boardTiltDeg`，第 93–110 行）
- Modify: `renderer/src/lib/guidedSequence.js`（删除 `cornersCentroid` / `boardRollDeg` / `boardScale` / `analyzeBoard`，改为从 `boardMetrics.js` 重新导出）
- Modify: `renderer/src/tabs/FisheyeTab.jsx:15`（`boardTiltDeg` 的 import 来源）
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `extentFromCircle(circle) -> {cx,cy,rx,ry} | null`
  - `extentFromImageSize(imageSize) -> {cx,cy,rx,ry} | null`　（`imageSize` 为 `[w,h]`）
  - `minRadius(extent) -> number`　（`Math.min(rx, ry)`，extent 为空时 `0`）
  - `cornersCentroid(corners) -> {x,y} | null`
  - `boardTiltDeg(corners, cols, rows) -> number | null`
  - `boardRollDeg(corners, cols) -> number | null`
  - `boardScale(corners, cols, rows, extent) -> number | null`
  - `analyzeBoard(corners, board, extent) -> {centroid, tilt, roll, scale}`

- [ ] **Step 1: 接入 `node --test`**

`package.json` 的 `scripts` 里加一条（放在 `i18n:check` 之后）：

```json
"test": "node --test renderer/src",
```

`.github/workflows/ci.yml` 的 `renderer` job，在 `Build renderer` 步骤**之前**插入：

```yaml
      - name: Unit tests
        run: npm test
```

- [ ] **Step 2: 写失败的测试**

创建 `renderer/src/lib/boardMetrics.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extentFromCircle, extentFromImageSize, minRadius,
  cornersCentroid, boardTiltDeg, boardRollDeg, boardScale, analyzeBoard,
} from './boardMetrics.js';

// A 3x2 fronto-parallel board (row-major, like OpenCV's findChessboardCorners),
// 100px wide, 50px tall, top-left at (100, 100).
const FLAT = [
  [100, 100], [150, 100], [200, 100],
  [100, 150], [150, 150], [200, 150],
];
const COLS = 3, ROWS = 2;

test('extentFromCircle turns a circle into a square extent', () => {
  assert.deepEqual(extentFromCircle({ cx: 10, cy: 20, r: 5 }), { cx: 10, cy: 20, rx: 5, ry: 5 });
  assert.equal(extentFromCircle(null), null);
});

test('extentFromImageSize covers the whole rectangle', () => {
  assert.deepEqual(extentFromImageSize([640, 480]), { cx: 320, cy: 240, rx: 320, ry: 240 });
  assert.equal(extentFromImageSize(null), null);
  assert.equal(extentFromImageSize([0, 480]), null);
});

test('minRadius takes the smaller半轴', () => {
  assert.equal(minRadius({ cx: 0, cy: 0, rx: 320, ry: 240 }), 240);
  assert.equal(minRadius({ cx: 0, cy: 0, rx: 5, ry: 5 }), 5);
  assert.equal(minRadius(null), 0);
});

test('cornersCentroid averages the corners', () => {
  assert.deepEqual(cornersCentroid(FLAT), { x: 150, y: 125 });
  assert.equal(cornersCentroid([]), null);
  assert.equal(cornersCentroid(null), null);
});

test('boardTiltDeg reads ~0 for a fronto-parallel board', () => {
  const tilt = boardTiltDeg(FLAT, COLS, ROWS);
  assert.ok(tilt !== null && tilt < 0.5, `expected ~0, got ${tilt}`);
});

test('boardTiltDeg grows when the board is perspective-skewed', () => {
  // top edge shortened toward the centre => trapezoid => non-90° interior angles
  const skew = [
    [125, 100], [150, 100], [175, 100],
    [100, 150], [150, 150], [200, 150],
  ];
  const tilt = boardTiltDeg(skew, COLS, ROWS);
  assert.ok(tilt > 10, `expected a clear tilt, got ${tilt}`);
});

test('boardTiltDeg returns null when corners are short', () => {
  assert.equal(boardTiltDeg([[0, 0]], COLS, ROWS), null);
  assert.equal(boardTiltDeg(null, COLS, ROWS), null);
});

test('boardRollDeg reads 0 for a level board and ~30 for a rotated one', () => {
  assert.ok(boardRollDeg(FLAT, COLS) < 0.001);
  // top edge rotated 30° clockwise about corner 0
  const a = (30 * Math.PI) / 180;
  const rolled = FLAT.map(([x, y]) => {
    const dx = x - 100, dy = y - 100;
    return [100 + dx * Math.cos(a) - dy * Math.sin(a), 100 + dx * Math.sin(a) + dy * Math.cos(a)];
  });
  assert.ok(Math.abs(boardRollDeg(rolled, COLS) - 30) < 0.001);
});

test('boardRollDeg folds into [0,45] — a 60° rotation reads as 30', () => {
  const a = (60 * Math.PI) / 180;
  const rolled = FLAT.map(([x, y]) => {
    const dx = x - 100, dy = y - 100;
    return [100 + dx * Math.cos(a) - dy * Math.sin(a), 100 + dx * Math.sin(a) + dy * Math.cos(a)];
  });
  assert.ok(Math.abs(boardRollDeg(rolled, COLS) - 30) < 0.001);
});

test('boardScale divides the quad span by the extent diameter', () => {
  // quad corners: (100,100) (200,100) (200,150) (100,150) => max diagonal ~111.803
  const span = Math.hypot(100, 50);
  assert.ok(Math.abs(boardScale(FLAT, COLS, ROWS, { cx: 0, cy: 0, rx: 100, ry: 100 }) - span / 200) < 1e-9);
  // a非方 extent uses the SHORTER半轴
  assert.ok(Math.abs(boardScale(FLAT, COLS, ROWS, { cx: 0, cy: 0, rx: 320, ry: 240 }) - span / 480) < 1e-9);
  assert.equal(boardScale(FLAT, COLS, ROWS, null), null);
});

test('analyzeBoard bundles the four measurements', () => {
  const m = analyzeBoard(FLAT, { cols: COLS, rows: ROWS }, { cx: 0, cy: 0, rx: 100, ry: 100 });
  assert.deepEqual(m.centroid, { x: 150, y: 125 });
  assert.ok(m.tilt < 0.5);
  assert.ok(m.roll < 0.001);
  assert.ok(m.scale > 0);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../lib/boardMetrics.js'`

- [ ] **Step 4: 写实现**

创建 `renderer/src/lib/boardMetrics.js`：

```js
// Geometry-neutral measurements of a detected calibration board.
//
// Everything here works off the raw corner list ([[x,y], …], row-major as
// OpenCV returns it) and knows nothing about the camera model — a fisheye and a
// pinhole board are measured identically. The camera-model-specific part is the
// EXTENT the measurement is normalised against (see below).
//
// An "extent" is the region of the image a board can meaningfully live in:
//   • fisheye → the detected image circle, as {cx, cy, rx: r, ry: r}
//   • pinhole → the whole frame,           as {cx: w/2, cy: h/2, rx: w/2, ry: h/2}
// Because a fisheye extent always has rx === ry, every formula below that takes
// min(rx, ry) reduces to the old circle-radius form exactly — that identity is
// what lets the fisheye path stay numerically unchanged.

export function extentFromCircle(circle) {
  if (!circle || !circle.r) return null;
  return { cx: circle.cx, cy: circle.cy, rx: circle.r, ry: circle.r };
}

export function extentFromImageSize(imageSize) {
  if (!imageSize) return null;
  const [w, h] = imageSize;
  if (!w || !h) return null;
  return { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 };
}

// The inscribed radius — the half-axis a board is guaranteed to fit within in
// every direction. All scale/acceptance thresholds normalise against this.
export function minRadius(extent) {
  if (!extent) return 0;
  return Math.min(extent.rx, extent.ry);
}

// Centroid of the detected corners.
export function cornersCentroid(corners) {
  if (!corners?.length) return null;
  let sx = 0, sy = 0;
  for (const c of corners) { sx += c[0]; sy += c[1]; }
  return { x: sx / corners.length, y: sy / corners.length };
}

// Board tilt proxy (degrees), with no need for intrinsics. From the four outer
// corners of the chessboard quad we measure how far its interior angles deviate
// from 90°: a fronto-parallel board projects to a near-rectangle (≈0°), while a
// tilted board's perspective skews the angles. Used to enforce *orientation*
// diversity (not just position) during capture. Returns null if corners are short.
export function boardTiltDeg(corners, cols, rows) {
  const n = cols * rows;
  if (!corners || corners.length < n) return null;
  const quad = [corners[0], corners[cols - 1], corners[n - 1], corners[cols * (rows - 1)]];
  const ang = (p, c, q) => {
    const v1x = p[0] - c[0], v1y = p[1] - c[1], v2x = q[0] - c[0], v2y = q[1] - c[1];
    const d = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) || 1) * (Math.hypot(v2x, v2y) || 1));
    return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
  };
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.abs(ang(quad[(i + 3) % 4], quad[i], quad[(i + 1) % 4]) - 90);
  return s / 4;
}

// In-plane rotation (roll) proxy in degrees, |angle| ∈ [0,45]. From the board's
// top edge (corner 0 → corner cols-1) measured against the image horizontal.
// A chessboard reads the same every 90°, so we fold into [-45,45] and take |·|.
// Unlike boardTiltDeg (which only sees perspective skew), this catches a board
// rotated like a clock face while staying fronto-parallel.
export function boardRollDeg(corners, cols) {
  if (!corners || corners.length < cols) return null;
  const a = corners[0], b = corners[cols - 1];
  let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;  // -180…180
  deg = ((deg % 90) + 90) % 90;          // 0…90
  if (deg > 45) deg -= 90;               // -45…45
  return Math.abs(deg);
}

// Apparent board size: span of the four outer corners / the extent's inscribed
// diameter. ~1 means the board fills the short axis; small means it's far away.
export function boardScale(corners, cols, rows, extent) {
  const n = cols * rows;
  const r = minRadius(extent);
  if (!corners || corners.length < n || !r) return null;
  const quad = [corners[0], corners[cols - 1], corners[n - 1], corners[cols * (rows - 1)]];
  let maxD = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    maxD = Math.max(maxD, Math.hypot(quad[i][0] - quad[j][0], quad[i][1] - quad[j][1]));
  }
  return maxD / (2 * r);
}

// One-shot analysis of the live board for the guided gates + overlay.
export function analyzeBoard(corners, board, extent) {
  const cols = board?.cols ?? 9, rows = board?.rows ?? 6;
  return {
    centroid: cornersCentroid(corners),
    tilt: boardTiltDeg(corners, cols, rows),
    roll: boardRollDeg(corners, cols),
    scale: boardScale(corners, cols, rows, extent),
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 11 个 test 全绿

- [ ] **Step 6: 把旧的实现摘掉，改为从新模块取**

`renderer/src/lib/polarCoverage.js`：删除文件末尾的 `boardTiltDeg`（连同它上方那段以 `// Board tilt proxy (degrees)` 开头的注释，原第 93–110 行）。

`renderer/src/lib/guidedSequence.js`：
1. 删除第 14 行 `import { boardTiltDeg } from './polarCoverage.js';`
2. 删除 `cornersCentroid`（原 89–95 行）、`boardRollDeg`（原 102–109 行）、`boardScale`（原 113–122 行）、`analyzeBoard`（原 125–133 行）四个函数。
3. 在文件顶部加：

```js
import { analyzeBoard, boardScale, minRadius } from './boardMetrics.js';

// Re-exported so existing consumers (LiveDetectedFrame, FisheyeTab) keep one
// import site for "the guided sequence's view of the board".
export { analyzeBoard, boardScale };
```

`renderer/src/tabs/FisheyeTab.jsx:15`：把 `boardTiltDeg` 从 `polarCoverage.js` 的 import 里摘掉，改成

```js
import { binPolar, pickGuidanceCell, totalPolarCells, polarCellAt, polarCellGeometry, RINGS, SECTORS } from '../lib/polarCoverage.js';
import { boardTiltDeg } from '../lib/boardMetrics.js';
```

- [ ] **Step 7: 验证**

Run: `npm test && npm run lint && npm run build:renderer`
Expected: 测试全绿、lint 无输出、build 成功

- [ ] **Step 8: 提交**

```bash
git add renderer/src/lib/boardMetrics.js renderer/src/lib/boardMetrics.test.js \
        renderer/src/lib/polarCoverage.js renderer/src/lib/guidedSequence.js \
        renderer/src/tabs/FisheyeTab.jsx package.json .github/workflows/ci.yml
git commit -m "refactor(lib): 抽出几何中立的 boardMetrics, 接入 node --test"
```

---

### Task 2: `guidedSequence.js` 泛化到 extent + profile

区域判定与姿态阈值目前写死鱼眼。改为吃 extent（矩形/圆通用）与 profile（鱼眼/针孔两套阈值），并把 `targetHalfSize` 从 `LiveDetectedFrame.jsx` 迁进来。

**Files:**
- Modify: `renderer/src/lib/guidedSequence.js`
- Create: `renderer/src/lib/guidedSequence.test.js`
- Modify: `renderer/src/components/LiveDetectedFrame.jsx`（删除本地 `targetHalfSize`，改为 import）
- Modify: `renderer/src/tabs/FisheyeTab.jsx`（`regionTarget` / `regionOk` / `poseOk` / `differsEnough` 的调用补参数）

**Interfaces:**
- Consumes: Task 1 的 `minRadius(extent)` / `analyzeBoard(corners, board, extent)` / `boardScale(corners, cols, rows, extent)`
- Produces:
  - `FISHEYE_PROFILE` / `PINHOLE_PROFILE`（对象，字段见下）
  - `regionTarget(region, extent) -> {x, y, acceptR} | null`
  - `regionOk(step, m, extent) -> boolean`
  - `poseOk(step, m, profile) -> boolean`
  - `differsEnough(sig, m, extent) -> boolean`
  - `shotSignature(m) -> {tilt, roll, scale, centroid} | null`
  - `targetHalfSize(step, extent, cols, rows) -> {halfW, halfH}`
  - `GUIDED_STEPS` / `GUIDED_TOTAL_SHOTS`（不变）

- [ ] **Step 1: 写失败的测试**

创建 `renderer/src/lib/guidedSequence.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUIDED_STEPS, GUIDED_TOTAL_SHOTS,
  FISHEYE_PROFILE, PINHOLE_PROFILE,
  regionTarget, regionOk, poseOk, differsEnough, shotSignature, targetHalfSize,
} from './guidedSequence.js';

const CIRCLE = { cx: 500, cy: 400, rx: 300, ry: 300 };   // fisheye-shaped extent
const RECT = { cx: 640, cy: 360, rx: 640, ry: 360 };     // pinhole 1280x720 extent

test('the checklist is 17 steps / 34 shots', () => {
  assert.equal(GUIDED_STEPS.length, 17);
  assert.equal(GUIDED_TOTAL_SHOTS, 34);
});

test('regionTarget places center at the extent centre', () => {
  const t = regionTarget('center', CIRCLE);
  assert.equal(t.x, 500);
  assert.equal(t.y, 400);
  assert.ok(Math.abs(t.acceptR - 0.38 * 300) < 1e-9);
});

test('regionTarget scales x by rx and y by ry independently', () => {
  const t = regionTarget('right', RECT);         // ux=1, uy=0, rf=0.82
  assert.ok(Math.abs(t.x - (640 + 0.82 * 640)) < 1e-9);
  assert.equal(t.y, 360);
  const b = regionTarget('bottom', RECT);        // ux=0, uy=1, rf=0.82
  assert.equal(b.x, 640);
  assert.ok(Math.abs(b.y - (360 + 0.82 * 360)) < 1e-9);
});

// THE REGRESSION GUARD for the extent generalisation: on a square extent
// (rx === ry === r, i.e. every fisheye) the new formula must reproduce the old
// circle formula exactly, for every region.
test('on a square extent regionTarget equals the old circle formula', () => {
  const r = 300, cx = 500, cy = 400;
  const OLD = {                                   // pre-refactor: ux/L * rf * r
    center: [0, 0, 0.0, 0.38], tl: [-1, -1, 0.55, 0.42], tr: [1, -1, 0.55, 0.42],
    bl: [-1, 1, 0.55, 0.42], br: [1, 1, 0.55, 0.42],
    top: [0, -1, 0.82, 0.42], bottom: [0, 1, 0.82, 0.42],
    left: [-1, 0, 0.82, 0.42], right: [1, 0, 0.82, 0.42],
  };
  for (const [region, [ux, uy, rf, accept]] of Object.entries(OLD)) {
    const L = Math.hypot(ux, uy) || 1;
    const want = { x: cx + (ux / L) * rf * r, y: cy + (uy / L) * rf * r, acceptR: accept * r };
    assert.deepEqual(regionTarget(region, { cx, cy, rx: r, ry: r }), want, `region ${region}`);
  }
});

test('regionTarget returns null without an extent', () => {
  assert.equal(regionTarget('center', null), null);
});

test('regionOk accepts inside the radius and rejects outside', () => {
  const step = { region: 'center' };
  const inside = { centroid: { x: 500 + 100, y: 400 } };     // 100 < 0.38*300 = 114
  const outside = { centroid: { x: 500 + 200, y: 400 } };
  assert.equal(regionOk(step, inside, CIRCLE), true);
  assert.equal(regionOk(step, outside, CIRCLE), false);
  assert.equal(regionOk(step, { centroid: null }, CIRCLE), false);
});

test('poseOk frontal uses the profile tilt ceiling', () => {
  const step = { pose: 'frontal' };
  assert.equal(poseOk(step, { tilt: 11, roll: 0 }, FISHEYE_PROFILE), true);   // <= 12
  assert.equal(poseOk(step, { tilt: 11, roll: 0 }, PINHOLE_PROFILE), false);  // >  10
  assert.equal(poseOk(step, { tilt: 9, roll: 0 }, PINHOLE_PROFILE), true);
});

test('poseOk tilted uses the profile tilt floor', () => {
  const step = { pose: 'tilted' };
  assert.equal(poseOk(step, { tilt: 8 }, FISHEYE_PROFILE), false);   // < 10
  assert.equal(poseOk(step, { tilt: 8 }, PINHOLE_PROFILE), true);    // >= 7
  assert.equal(poseOk(step, { tilt: null }, PINHOLE_PROFILE), false);
});

test('poseOk dist splits near/far/mid at the profile thresholds', () => {
  assert.equal(poseOk({ pose: 'dist', scale: 'near' }, { scale: 0.6 }, FISHEYE_PROFILE), true);
  assert.equal(poseOk({ pose: 'dist', scale: 'near' }, { scale: 0.6 }, PINHOLE_PROFILE), false);
  assert.equal(poseOk({ pose: 'dist', scale: 'near' }, { scale: 0.8 }, PINHOLE_PROFILE), true);
  assert.equal(poseOk({ pose: 'dist', scale: 'far' }, { scale: 0.3 }, PINHOLE_PROFILE), true);
  assert.equal(poseOk({ pose: 'dist', scale: 'mid' }, { scale: 0.5 }, PINHOLE_PROFILE), true);
  assert.equal(poseOk({ pose: 'dist', scale: null }, { scale: null }, PINHOLE_PROFILE), false);
});

test('poseOk roll needs rotation while staying flat', () => {
  const step = { pose: 'roll' };
  assert.equal(poseOk(step, { roll: 20, tilt: 5 }, FISHEYE_PROFILE), true);
  assert.equal(poseOk(step, { roll: 10, tilt: 5 }, FISHEYE_PROFILE), false);   // < ROLL_MIN
  assert.equal(poseOk(step, { roll: 20, tilt: 40 }, FISHEYE_PROFILE), false);  // not flat
});

test('differsEnough fires on any one of tilt / roll / scale / position', () => {
  const base = { tilt: 5, roll: 5, scale: 0.4, centroid: { x: 100, y: 100 } };
  assert.equal(differsEnough(null, base, CIRCLE), true);            // no prior shot
  assert.equal(differsEnough(base, { ...base }, CIRCLE), false);    // identical
  assert.equal(differsEnough(base, { ...base, tilt: 8 }, CIRCLE), true);
  assert.equal(differsEnough(base, { ...base, roll: 8 }, CIRCLE), true);
  assert.equal(differsEnough(base, { ...base, scale: 0.43 }, CIRCLE), true);
  assert.equal(differsEnough(base, { ...base, centroid: { x: 120, y: 100 } }, CIRCLE), true);  // 20 >= 300*0.03
});

test('shotSignature snapshots the four measurements', () => {
  const m = { tilt: 1, roll: 2, scale: 3, centroid: { x: 4, y: 5 }, extra: 'dropped' };
  assert.deepEqual(shotSignature(m), { tilt: 1, roll: 2, scale: 3, centroid: { x: 4, y: 5 } });
  assert.equal(shotSignature(null), null);
});

test('targetHalfSize keeps the board aspect and shrinks for edges/far', () => {
  const center = targetHalfSize({ region: 'center', group: 'frontal', pose: 'frontal' }, CIRCLE, 9, 6);
  assert.ok(Math.abs(center.halfW - 0.42 * 300) < 1e-9);
  assert.ok(Math.abs(center.halfH - center.halfW * (6 / 9)) < 1e-9);
  const edge = targetHalfSize({ region: 'top', group: 'edge', pose: 'frontal' }, CIRCLE, 9, 6);
  assert.ok(edge.halfW < center.halfW);
  const far = targetHalfSize({ region: 'center', group: 'dist', pose: 'dist', scale: 'far' }, CIRCLE, 9, 6);
  assert.ok(Math.abs(far.halfW - 0.27 * 300) < 1e-9);
});

test('targetHalfSize normalises against the SHORT axis on a rect extent', () => {
  const t = targetHalfSize({ region: 'center', group: 'frontal', pose: 'frontal' }, RECT, 9, 6);
  assert.ok(Math.abs(t.halfW - 0.42 * 360) < 1e-9);   // min(640, 360)
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — `guidedSequence.js` 未导出 `FISHEYE_PROFILE` / `PINHOLE_PROFILE` / `targetHalfSize`

- [ ] **Step 3: 改实现**

`renderer/src/lib/guidedSequence.js`：把原来第 16–54 行的阈值常量段与 `REGIONS` 替换为下面这段（`REGIONS` 的数值不变，只是 `accept` 保留在其中；四个姿态阈值搬进 profile）：

```js
// ── Pose / scale acceptance profiles ─────────────────────────────────────────
// The checklist itself (GUIDED_STEPS) and the region layout (REGIONS) are
// camera-model-independent — "put the board top-left, tilt it" means the same
// thing through any lens. What DOES differ is how much a given physical pose
// shows up in the picture, so the acceptance thresholds are per-model.
//
// TILT_* are readings of the boardTiltDeg perspective proxy, kept LOW on purpose.
// The limiter is not detectability but the auto-capture gate: a tilt step needs
// the pose held STILL + SHARP + continuously detected through the 500ms dwell,
// and the fast live detector drops out intermittently while the board is moving.
// A reading an operator can comfortably SUSTAIN tops out around 13–16° on a
// fisheye, so accept from 10° there.
export const FISHEYE_PROFILE = {
  name: 'fisheye',
  TILT_FRONTAL_MAX: 12,   // a "正对" frame must be flatter than this (deg)
  TILT_MIN: 10,           // a tilt/yaw frame must skew at least this much
  ROLL_MIN: 15,           // an in-plane roll frame must rotate at least this
  ROLL_FRONTAL_MAX: 12,   // ...while staying roughly fronto-parallel
  // board span / extent diameter. On real fisheye captures a board that visually
  // "fills the frame" still only spans ~0.55–0.65 of the circle diameter (the
  // periphery is heavily compressed), so NEAR sits where a genuine close-in shot
  // lands rather than at 1.0. Validated against the /tmp/1 + /tmp/4 sample sets.
  SCALE_NEAR: 0.54,       // "拉近占满"
  SCALE_FAR: 0.38,        // "推远变小"
};

// A pinhole lens has a narrower field of view and no radial compression, so:
//   • the same physical tilt produces LESS perspective skew → lower tilt gates;
//   • a board that fills the frame really does span ~0.9 of the short axis
//     (vs ~0.6 on a fisheye) → higher scale gates.
// NOTE: these four values are derived from the geometry, NOT yet validated on a
// real pinhole capture session. They only affect WHEN guided auto-capture fires,
// never the calibration result — retune against real footage.
export const PINHOLE_PROFILE = {
  name: 'pinhole',
  TILT_FRONTAL_MAX: 10,
  TILT_MIN: 7,
  ROLL_MIN: 15,
  ROLL_FRONTAL_MAX: 12,
  SCALE_NEAR: 0.75,
  SCALE_FAR: 0.40,
};

// region acceptance radius, as a fraction of the extent's inscribed radius
const ACCEPT_CENTER = 0.38;
const ACCEPT_OFF = 0.42;

// Region unit-direction (screen coords: x right, y down) + radial fraction of
// the extent's half-axes where the board centroid should sit.
const REGIONS = {
  center: { ux: 0,  uy: 0,  rf: 0.0,  accept: ACCEPT_CENTER },
  tl:     { ux: -1, uy: -1, rf: 0.55, accept: ACCEPT_OFF },
  tr:     { ux: 1,  uy: -1, rf: 0.55, accept: ACCEPT_OFF },
  bl:     { ux: -1, uy: 1,  rf: 0.55, accept: ACCEPT_OFF },
  br:     { ux: 1,  uy: 1,  rf: 0.55, accept: ACCEPT_OFF },
  top:    { ux: 0,  uy: -1, rf: 0.82, accept: ACCEPT_OFF },
  bottom: { ux: 0,  uy: 1,  rf: 0.82, accept: ACCEPT_OFF },
  left:   { ux: -1, uy: 0,  rf: 0.82, accept: ACCEPT_OFF },
  right:  { ux: 1,  uy: 0,  rf: 0.82, accept: ACCEPT_OFF },
};
```

然后把 `regionTarget` / `poseOk` / `differsEnough` 三个函数替换为：

```js
// Target point for a step's region, in image-pixel coords, plus the acceptance
// radius (px). x scales with rx and y with ry, so a wide pinhole frame reaches
// its real left/right edges; on a square (fisheye) extent this reduces exactly
// to the old circle form. Returns null without an extent.
export function regionTarget(region, extent) {
  if (!extent) return null;
  const r = REGIONS[region] || REGIONS.center;
  const L = Math.hypot(r.ux, r.uy) || 1;
  return {
    x: extent.cx + (r.ux / L) * r.rf * extent.rx,
    y: extent.cy + (r.uy / L) * r.rf * extent.ry,
    acceptR: r.accept * minRadius(extent),
  };
}

export function regionOk(step, m, extent) {
  const t = regionTarget(step.region, extent);
  if (!t || !m.centroid) return false;
  return Math.hypot(m.centroid.x - t.x, m.centroid.y - t.y) <= t.acceptR;
}

// Does the live board's orientation/size satisfy the step's pose requirement?
export function poseOk(step, m, profile = FISHEYE_PROFILE) {
  switch (step.pose) {
    case 'frontal':
      return m.tilt != null && m.tilt <= profile.TILT_FRONTAL_MAX
        && (m.roll == null || m.roll <= profile.TILT_FRONTAL_MAX + 6);
    case 'tilted':
      return m.tilt != null && m.tilt >= profile.TILT_MIN;
    case 'roll':
      return m.roll != null && m.roll >= profile.ROLL_MIN
        && (m.tilt == null || m.tilt <= profile.ROLL_FRONTAL_MAX + 8);
    case 'dist':
      if (m.scale == null) return false;
      if (step.scale === 'near') return m.scale >= profile.SCALE_NEAR;
      if (step.scale === 'far') return m.scale <= profile.SCALE_FAR;
      return m.scale > profile.SCALE_FAR && m.scale < profile.SCALE_NEAR;  // 'mid'
    default:
      return true;
  }
}

// The two-shots-per-action rule: the SECOND shot must differ from the first by a
// small but real amount, so we bank a slightly varied view rather than a near
// duplicate. A nudge in tilt, roll, or position all count.
export function differsEnough(sig, m, extent) {
  if (!sig || !m) return true;
  if (m.tilt != null && sig.tilt != null && Math.abs(m.tilt - sig.tilt) >= 2) return true;
  if (m.roll != null && sig.roll != null && Math.abs(m.roll - sig.roll) >= 2) return true;
  if (m.scale != null && sig.scale != null && Math.abs(m.scale - sig.scale) >= 0.025) return true;
  const r = minRadius(extent);
  if (m.centroid && sig.centroid && r) {
    if (Math.hypot(m.centroid.x - sig.centroid.x, m.centroid.y - sig.centroid.y) >= r * 0.03) return true;
  }
  return false;
}
```

最后在文件末尾追加迁入的 `targetHalfSize`：

```js
// Recommended on-screen half-size of the target board, as a fraction of the
// extent's inscribed radius — bigger for centre/near, smaller for edges/far
// (docs/fisheye-calibration-howto.md §3: a centred board should fill ~1/3–1/2 of
// the frame, edge boards may be smaller). Aspect ≈ the real board's cols:rows so
// the operator matches shape, not just position.
export function targetHalfSize(step, extent, bCols, bRows) {
  const r = minRadius(extent);
  let frac;
  if (step.pose === 'dist') frac = step.scale === 'near' ? 0.5 : step.scale === 'far' ? 0.27 : 0.38;
  else if (step.group === 'edge') frac = 0.27;
  else if (step.region === 'center') frac = 0.42;
  else frac = 0.34;
  const halfW = frac * r;
  return { halfW, halfH: halfW * (bRows / Math.max(1, bCols)) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 含那条「square extent 下与旧圆公式逐点相等」的回归断言

- [ ] **Step 5: 更新调用方**

`renderer/src/components/LiveDetectedFrame.jsx`：
1. 删除本地的 `targetHalfSize`（原 57–70 行，连同上方注释）。
2. 第 6 行的 import 改为：

```js
import { regionTarget, boardScale, targetHalfSize } from '../lib/guidedSequence.js';
```

`renderer/src/tabs/FisheyeTab.jsx`：把 `poseOk(step, m)` 的调用改为 `poseOk(step, m, FISHEYE_PROFILE)`，并把 `FISHEYE_PROFILE` 加进第 16–19 行的 import。`regionTarget` / `regionOk` / `differsEnough` 仍传 `circleG`（此时是 `{cx,cy,r}` 形状）—— **暂时会失配**，Task 6 迁到 hook 时统一改为 extent。为了让本任务结束时代码可运行，先在 `FisheyeTab.jsx` 里把传给这三个函数的实参包一层：

```js
import { extentFromCircle } from '../lib/boardMetrics.js';
// …在 onAutoMeta 的 guided 分支里：
const extG = extentFromCircle(circleG);
const rOk = regionOk(step, m, extG);
const needVary = shots === 1 && !differsEnough(guidedSigRef.current, m, extG);
// …以及 guidedSteer 的目标：
guidedSteer(m.centroid?.x, m.centroid?.y, regionTarget(step.region, extG), circleG, step.id);
```

同时 `analyzeBoard(corners, boardRef.current, circleG)` 改为 `analyzeBoard(corners, boardRef.current, extG)`。

- [ ] **Step 6: 验证**

Run: `npm test && npm run lint && npm run build:renderer`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add renderer/src/lib/guidedSequence.js renderer/src/lib/guidedSequence.test.js \
        renderer/src/components/LiveDetectedFrame.jsx renderer/src/tabs/FisheyeTab.jsx
git commit -m "refactor(lib): guidedSequence 泛化到 extent + 双 profile"
```

---

### Task 3: `coverage.js` 补矩形网格的几何与引导

矩形网格要能和极坐标一样回答「每格中心在哪」「下一个该补哪格」。

**Files:**
- Modify: `renderer/src/lib/coverage.js`
- Create: `renderer/src/lib/coverage.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `cellGeometry(imageSize, cols?, rows?) -> [{index, x, y}]`（格心的图像像素坐标）
  - `pickGuidanceCell(counts, mask?, cols?, rows?) -> number | null`
  - 已有的 `COVERAGE_COLS = 8` / `COVERAGE_ROWS = 5` / `cellIndexFor` / `cellCornerCounts` / `computeCoverage` / `fovCellMask` 不变

- [ ] **Step 1: 写失败的测试**

创建 `renderer/src/lib/coverage.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_COLS, COVERAGE_ROWS, cellGeometry, pickGuidanceCell, cellIndexFor,
} from './coverage.js';

const SIZE = [800, 500];              // 8x5 grid => each cell 100x100
const TOTAL = COVERAGE_COLS * COVERAGE_ROWS;

test('cellGeometry returns one centre per cell, row-major', () => {
  const geo = cellGeometry(SIZE);
  assert.equal(geo.length, TOTAL);
  assert.deepEqual(geo[0], { index: 0, x: 50, y: 50 });
  assert.deepEqual(geo[7], { index: 7, x: 750, y: 50 });
  assert.deepEqual(geo[8], { index: 8, x: 50, y: 150 });
  assert.deepEqual(geo[TOTAL - 1], { index: TOTAL - 1, x: 750, y: 450 });
});

test('cellGeometry centres round-trip through cellIndexFor', () => {
  for (const g of cellGeometry(SIZE)) {
    assert.equal(cellIndexFor(g.x, g.y, SIZE), g.index);
  }
});

test('cellGeometry returns empty without a usable size', () => {
  assert.deepEqual(cellGeometry(null), []);
  assert.deepEqual(cellGeometry([0, 500]), []);
});

test('pickGuidanceCell returns null once every cell has a capture', () => {
  assert.equal(pickGuidanceCell(new Array(TOTAL).fill(1)), null);
  assert.equal(pickGuidanceCell(null), null);
  assert.equal(pickGuidanceCell([]), null);
});

test('pickGuidanceCell picks an empty cell', () => {
  const counts = new Array(TOTAL).fill(3);
  counts[19] = 0;
  assert.equal(pickGuidanceCell(counts), 19);
});

test('pickGuidanceCell breaks ties toward the outer ring', () => {
  const counts = new Array(TOTAL).fill(3);
  counts[20] = 0;   // col 4, row 2 — dead centre
  counts[0] = 0;    // col 0, row 0 — corner
  assert.equal(pickGuidanceCell(counts), 0);
});

test('pickGuidanceCell skips masked-out cells', () => {
  const counts = new Array(TOTAL).fill(3);
  counts[0] = 0;
  const mask = new Array(TOTAL).fill(true);
  mask[0] = false;                 // the only empty cell is not coverable
  assert.equal(pickGuidanceCell(counts, mask), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — `cellGeometry is not a function`

- [ ] **Step 3: 写实现**

在 `renderer/src/lib/coverage.js` 末尾追加：

```js
// Centre of every cell, in image-pixel coords — the cartesian twin of
// polarCellGeometry. Used to steer the board toward a target cell.
export function cellGeometry(imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  if (!imageSize) return [];
  const [w, h] = imageSize;
  if (!w || !h) return [];
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ index: r * cols + c, x: ((c + 0.5) / cols) * w, y: ((r + 0.5) / rows) * h });
    }
  }
  return out;
}

// How far out a cell sits, 0 (centre) … 2 (edge). The cartesian stand-in for the
// polar grid's ring index, used only to break guidance ties.
function cellRing(index, cols, rows) {
  const ci = index % cols, ri = Math.floor(index / cols);
  const nx = Math.abs((ci + 0.5) / cols - 0.5) * 2;   // 0…1
  const ny = Math.abs((ri + 0.5) / rows - 0.5) * 2;
  const d = Math.max(nx, ny);
  return d < 1 / 3 ? 0 : d < 2 / 3 ? 1 : 2;
}

// Pick the cell to guide the user toward next: the emptiest cell, breaking ties
// toward the outer ring (the edge of the frame carries the most distortion
// information and is the hardest to fill). Mirrors pickGuidanceCell in
// polarCoverage.js, including its "stop nagging once nothing is empty" rule.
// `mask` (optional) marks cells that can never be covered; they are skipped.
export function pickGuidanceCell(counts, mask = null, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  if (!counts?.length) return null;
  let best = null, bestScore = Infinity;
  for (let i = 0; i < cols * rows; i++) {
    if (mask && !mask[i]) continue;
    const n = counts[i] ?? 0;
    // lower count wins; among equal counts, the outer ring wins → subtract ring.
    const score = n * 100 - cellRing(i, cols, rows);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best == null) return null;
  // Only guide while something is still empty; once all covered, stop nagging.
  return (counts[best] ?? 0) === 0 ? best : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 验证并提交**

```bash
npm run lint && npm run build:renderer
git add renderer/src/lib/coverage.js renderer/src/lib/coverage.test.js
git commit -m "feat(lib): coverage 补矩形网格的 cellGeometry 与 pickGuidanceCell"
```

---

### Task 4: 几何适配器

把「极坐标」与「矩形」两套分箱包装成同一个接口，供状态机注入。

**Files:**
- Create: `renderer/src/lib/smartCapture/geometry.js`
- Create: `renderer/src/lib/smartCapture/geometry.test.js`

**Interfaces:**
- Consumes: Task 1 的 `extentFromCircle` / `extentFromImageSize`；Task 3 的 `cellGeometry` / `pickGuidanceCell`；已有的 `binPolar` / `polarCellAt` / `polarCellGeometry` / `totalPolarCells` / `pickGuidanceCell`（polar 版）/ `cellCornerCounts` / `cellIndexFor`
- Produces: 两个工厂，都返回同一形状的**适配器对象**：

  ```
  {
    kind: 'polar' | 'rect',
    totalCells: number,
    extent: {cx,cy,rx,ry} | null,
    bin(corners) -> int[totalCells],
    cellAt(x, y) -> number | null,
    cellCenter(index) -> {x, y} | null,
    pickGuidance(counts) -> number | null,
    radialCue(cur, target) -> 'moveOut' | null,
  }
  ```
  - `makePolarGeometry(circle)` — `circle` 为 `{cx,cy,r}` 或 `null`
  - `makeRectGeometry(imageSize)` — `imageSize` 为 `[w,h]` 或 `null`

  两者在输入为 `null` 时仍返回可用对象（`extent: null`，`bin` 返回全零，`cellAt`/`cellCenter` 返回 `null`），这样状态机在圆检测落地前不会崩。

- [ ] **Step 1: 写失败的测试**

创建 `renderer/src/lib/smartCapture/geometry.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePolarGeometry, makeRectGeometry } from './geometry.js';
import { totalPolarCells, polarCellAt, binPolar, polarCellGeometry } from '../polarCoverage.js';
import { COVERAGE_COLS, COVERAGE_ROWS } from '../coverage.js';

const CIRCLE = { cx: 500, cy: 400, r: 300 };
const SIZE = [800, 500];

test('polar adapter reports the polar cell count and a square extent', () => {
  const g = makePolarGeometry(CIRCLE);
  assert.equal(g.kind, 'polar');
  assert.equal(g.totalCells, totalPolarCells());
  assert.deepEqual(g.extent, { cx: 500, cy: 400, rx: 300, ry: 300 });
});

test('polar adapter delegates bin / cellAt / cellCenter to polarCoverage', () => {
  const g = makePolarGeometry(CIRCLE);
  const corners = [[500, 400], [700, 400], [500, 600]];
  assert.deepEqual(g.bin(corners), binPolar(corners, CIRCLE));
  assert.equal(g.cellAt(500, 400), polarCellAt(500, 400, CIRCLE));
  const want = polarCellGeometry(CIRCLE).find(c => c.index === 3);
  assert.deepEqual(g.cellCenter(3), { x: want.x, y: want.y });
  assert.equal(g.cellCenter(9999), null);
});

test('polar adapter radialCue asks for "moveOut" only on a big outward jump', () => {
  const g = makePolarGeometry(CIRCLE);
  // target 200px further out than the current position; 200 > 300*0.33 = 99
  assert.equal(g.radialCue({ x: 500, y: 400 }, { x: 700, y: 400 }), 'moveOut');
  // only 50px further out => not a radial move
  assert.equal(g.radialCue({ x: 500, y: 400 }, { x: 550, y: 400 }), null);
  // moving inward is never "moveOut"
  assert.equal(g.radialCue({ x: 780, y: 400 }, { x: 520, y: 400 }), null);
});

test('polar adapter degrades safely without a circle', () => {
  const g = makePolarGeometry(null);
  assert.equal(g.extent, null);
  assert.equal(g.totalCells, totalPolarCells());
  assert.deepEqual(g.bin([[1, 2]]), new Array(totalPolarCells()).fill(0));
  assert.equal(g.cellAt(1, 2), null);
  assert.equal(g.cellCenter(0), null);
  assert.equal(g.radialCue({ x: 0, y: 0 }, { x: 1, y: 1 }), null);
});

test('rect adapter covers the whole frame', () => {
  const g = makeRectGeometry(SIZE);
  assert.equal(g.kind, 'rect');
  assert.equal(g.totalCells, COVERAGE_COLS * COVERAGE_ROWS);
  assert.deepEqual(g.extent, { cx: 400, cy: 250, rx: 400, ry: 250 });
  assert.equal(g.cellAt(50, 50), 0);
  assert.deepEqual(g.cellCenter(0), { x: 50, y: 50 });
});

test('rect adapter bins corners into cells', () => {
  const g = makeRectGeometry(SIZE);
  const counts = g.bin([[50, 50], [60, 60], [750, 450]]);
  assert.equal(counts[0], 2);
  assert.equal(counts[COVERAGE_COLS * COVERAGE_ROWS - 1], 1);
});

test('rect adapter has no radial semantics', () => {
  const g = makeRectGeometry(SIZE);
  assert.equal(g.radialCue({ x: 400, y: 250 }, { x: 750, y: 250 }), null);
});

test('rect adapter degrades safely without a size', () => {
  const g = makeRectGeometry(null);
  assert.equal(g.extent, null);
  assert.deepEqual(g.bin([[1, 2]]), new Array(COVERAGE_COLS * COVERAGE_ROWS).fill(0));
  assert.equal(g.cellAt(1, 2), null);
  assert.equal(g.cellCenter(0), null);
});

test('both adapters stop guiding once every cell has a capture', () => {
  const p = makePolarGeometry(CIRCLE);
  const r = makeRectGeometry(SIZE);
  assert.equal(p.pickGuidance(new Array(p.totalCells).fill(1)), null);
  assert.equal(r.pickGuidance(new Array(r.totalCells).fill(1)), null);
  const pc = new Array(p.totalCells).fill(1); pc[5] = 0;
  assert.equal(p.pickGuidance(pc), 5);
  const rc = new Array(r.totalCells).fill(1); rc[5] = 0;
  assert.equal(r.pickGuidance(rc), 5);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — 找不到 `./geometry.js`

- [ ] **Step 3: 写实现**

创建 `renderer/src/lib/smartCapture/geometry.js`：

```js
// Geometry adapters for useSmartCapture.
//
// The auto-capture state machine only ever asks four things of the image: how
// many cells are there, which cell does a point fall in, where is a cell's
// centre, and which cell should the operator fill next. Everything else about
// "circle vs rectangle" stays behind this interface, so the state machine itself
// is written once and shared by the fisheye and pinhole tabs.
//
// A factory always returns a usable adapter, even when its geometry is not known
// yet (the fisheye circle is auto-detected and lands a few frames late). In that
// state `extent` is null, `bin` returns all zeros and `cellAt`/`cellCenter`
// return null — the state machine reads that as "no coverage information" and
// simply does not fire.

import { extentFromCircle, extentFromImageSize } from '../boardMetrics.js';
import {
  binPolar, polarCellAt, polarCellGeometry, totalPolarCells,
  pickGuidanceCell as pickPolarGuidance, RINGS, SECTORS,
} from '../polarCoverage.js';
import {
  cellCornerCounts, cellIndexFor, cellGeometry,
  pickGuidanceCell as pickRectGuidance, COVERAGE_COLS, COVERAGE_ROWS,
} from '../coverage.js';

// How much further out a target must sit before we tell the operator to move
// toward the rim rather than left/right/up/down. Fraction of the circle radius.
const RADIAL_CUE_FRAC = 0.33;

export function makePolarGeometry(circle, rings = RINGS, sectors = SECTORS) {
  const total = totalPolarCells(rings, sectors);
  const geo = circle ? polarCellGeometry(circle, rings, sectors) : [];
  return {
    kind: 'polar',
    totalCells: total,
    extent: extentFromCircle(circle),
    bin: (corners) => (circle ? binPolar(corners, circle, rings, sectors) : new Array(total).fill(0)),
    cellAt: (x, y) => (circle ? polarCellAt(x, y, circle, rings, sectors) : null),
    cellCenter: (index) => {
      const g = geo.find(c => c.index === index);
      return g ? { x: g.x, y: g.y } : null;
    },
    pickGuidance: (counts) => pickPolarGuidance(counts, rings, sectors),
    // A dartboard has rings, so "the target is much further out" is its own
    // instruction — more useful than a left/right nudge across a wedge.
    radialCue: (cur, target) => {
      if (!circle || !cur || !target) return null;
      const curR = Math.hypot(cur.x - circle.cx, cur.y - circle.cy);
      const tgtR = Math.hypot(target.x - circle.cx, target.y - circle.cy);
      return tgtR - curR > circle.r * RADIAL_CUE_FRAC ? 'moveOut' : null;
    },
  };
}

export function makeRectGeometry(imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  const total = cols * rows;
  const geo = cellGeometry(imageSize, cols, rows);
  return {
    kind: 'rect',
    totalCells: total,
    extent: extentFromImageSize(imageSize),
    bin: (corners) => (imageSize ? cellCornerCounts(corners, imageSize, cols, rows) : new Array(total).fill(0)),
    cellAt: (x, y) => cellIndexFor(x, y, imageSize, cols, rows),
    cellCenter: (index) => {
      const g = geo[index];
      return g ? { x: g.x, y: g.y } : null;
    },
    // A pinhole frame has no vignette, so every cell is coverable — no mask.
    pickGuidance: (counts) => pickRectGuidance(counts, null, cols, rows),
    // A rectangle has no rings; steering is purely left/right/up/down.
    radialCue: () => null,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 验证并提交**

```bash
npm run lint && npm run build:renderer
git add renderer/src/lib/smartCapture/geometry.js renderer/src/lib/smartCapture/geometry.test.js
git commit -m "feat(lib): smartCapture 的极坐标/矩形几何适配器"
```

---

### Task 5: `useSmartCapture` 状态机

把 `FisheyeTab.jsx` 里的自动拍摄逻辑原样搬进一个 hook，几何调用换成适配器。本任务只**新建** hook，不动 FisheyeTab（Task 6 才切换），所以结束时 hook 尚无调用方 —— 这是刻意的，让搬运和切换分两次审。

**Files:**
- Create: `renderer/src/lib/smartCapture/useSmartCapture.js`

**Interfaces:**
- Consumes: Task 1 的 `analyzeBoard` / `boardTiltDeg`；Task 2 的 `GUIDED_STEPS` / `regionTarget` / `regionOk` / `poseOk` / `differsEnough` / `shotSignature`；Task 4 的适配器
- Produces:

  ```js
  useSmartCapture({
    enabled,        // bool — 自动拍摄开关
    liveDevice,     // string — 无设备时不触发
    datasetPath,    // string — 变化时重置整个采集会话
    autoRate = 0.5, // number — 两次自动拍摄的最小间隔（秒）
    board,          // {cols, rows, …}
    geometry,       // Task 4 的适配器
    profile,        // FISHEYE_PROFILE | PINHOLE_PROFILE
    mode = 'sweep', // 'sweep' | 'guided'
    mirror = false, // 口播左右是否随镜像互换
    guidance,       // number|null — 当前该补的格子（由页面按两阶段覆盖算出）
    doSnap,         // async () => ({path}) — 页面提供的“抓一帧”，含 pushUndo/刷新列表
    say,            // (clipName, minGapMs?) => void
    t,              // i18next 的 t
    setStatus,      // (msg, isErr?) => void
  })
  // →
  {
    onMeta,                        // (meta) => void，接到 <LiveDetectedFrame onMeta>
    autoHud,                       // {reason, dwell, tilt?, guidedLabel?} | null
    counts,                        // int[geometry.totalCells] — 拍摄期覆盖计数
    guidedProgress,                // {step, shots}
    resetSession(),                // 清空计数/倾角/停留/引导进度
    markFromManualSnap(opts?),     // ({silent}) 把最新一帧的角点计入覆盖
    advanceGuidedShot(),           // 手动拍摄时推进引导清单
    withSnapLock(fn),              // async；已有抓拍在飞时立刻返回 null
  }
  ```

- [ ] **Step 1: 写实现**

创建 `renderer/src/lib/smartCapture/useSmartCapture.js`：

```js
import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeBoard, boardTiltDeg } from '../boardMetrics.js';
import {
  GUIDED_STEPS, regionTarget, regionOk, poseOk, differsEnough, shotSignature,
} from '../guidedSequence.js';

// A snapped board only counts as covering a cell when at least this many of its
// corners land in that cell — so a board merely clipping a cell's edge (or the
// live board sweeping past without a capture) does not turn it green.
export const CAPTURE_MIN_CORNERS = 3;

// Hands-free auto-capture tuning. The board auto-snaps only when it is sharp,
// held still, and sitting in an under-sampled cell at a fresh tilt — and only
// after a short dwell, so you can sweep the board around and let it capture
// itself. None of these depend on the lens: the circle-vs-rectangle difference
// lives entirely in the injected `geometry` adapter.
const TARGET_PER_CELL = 5;     // stop auto-snapping a cell once it has this many
const DWELL_MS = 500;          // must hold the good pose this long before it fires
const SHARP_REL = 0.40;        // reject if blurrier than this fraction of the session-best
const SHARP_ABS = 40;          // absolute Laplacian-variance floor
const TILT_MIN_DIFF = 4;       // a follow-up capture in a cell must differ in tilt by ≥ this (deg)

export function useSmartCapture({
  enabled, liveDevice, datasetPath, autoRate = 0.5,
  board, geometry, profile, mode = 'sweep', mirror = false, guidance = null,
  doSnap, say, t, setStatus,
}) {
  const [counts, setCounts] = useState(() => new Array(geometry.totalCells).fill(0));
  const [autoHud, setAutoHud] = useState(null);
  const [guidedProgress, setGuidedProgress] = useState({ step: 0, shots: 0 });

  // Everything the per-frame handler reads goes through a ref, so `onMeta` keeps
  // a stable identity and the websocket inside LiveDetectedFrame is never torn
  // down and rebuilt just because a toggle changed.
  const geomRef = useRef(geometry);
  const boardRef = useRef(board);
  const modeRef = useRef(mode);
  const mirrorRef = useRef(mirror);
  const profileRef = useRef(profile);
  const countsRef = useRef(counts);
  const guidanceRef = useRef(guidance);
  const enabledRef = useRef(enabled);
  const deviceRef = useRef(liveDevice);
  const datasetRef = useRef(datasetPath);
  const rateRef = useRef(autoRate);
  const doSnapRef = useRef(doSnap);
  useEffect(() => { geomRef.current = geometry; }, [geometry]);
  useEffect(() => { boardRef.current = board; }, [board]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { mirrorRef.current = mirror; }, [mirror]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { countsRef.current = counts; }, [counts]);
  useEffect(() => { guidanceRef.current = guidance; }, [guidance]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { deviceRef.current = liveDevice; }, [liveDevice]);
  useEffect(() => { datasetRef.current = datasetPath; }, [datasetPath]);
  useEffect(() => { rateRef.current = autoRate; }, [autoRate]);
  useEffect(() => { doSnapRef.current = doSnap; }, [doSnap]);

  const sayRef = useRef(say);
  const tRef = useRef(t);
  const setStatusRef = useRef(setStatus);
  useEffect(() => { sayRef.current = say; }, [say]);
  useEffect(() => { tRef.current = t; }, [t]);
  useEffect(() => { setStatusRef.current = setStatus; }, [setStatus]);

  // Newest detection meta from the live stream, so a manual snap can bin the
  // corners it just saved (snap itself returns no corners).
  const latestMetaRef = useRef(null);
  const lastAutoSnapRef = useRef(0);
  const snapInFlightRef = useRef(false);  // blocks both auto and manual snaps
  const prevCornersRef = useRef(null);    // last frame's corners (for motion)
  const lastDetSeqRef = useRef(-1);       // last processed detection seq (skip repaints)
  const dwellStartRef = useRef(0);        // when the current good pose began
  const maxSharpRef = useRef(0);          // session-best sharpness (adaptive blur gate)
  // Per-cell list of captured board tilts (deg) — drives orientation diversity:
  // a 2nd/3rd capture in a cell only counts if its tilt is fresh.
  const cellTiltsRef = useRef(Array.from({ length: geometry.totalCells }, () => []));

  // Guided-sequence progress. guidedStepRef indexes GUIDED_STEPS; guidedShotsRef
  // is how many of this step's shots are banked (0..shots); guidedSigRef is the
  // first shot's signature, so the 2nd can be required to differ a little.
  const guidedStepRef = useRef(0);
  const guidedShotsRef = useRef(0);
  const guidedSigRef = useRef(null);
  // Directional-guidance state machine (see steer). Speaks only when it carries
  // new information, and goes quiet while the board is closing in.
  const dirStateRef = useRef({ dir: null, target: null, refDist: Infinity, lastSpeak: 0, arrived: false });

  // Cancellation flag so async snaps don't set state after unmount.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  const resetGuided = useCallback(() => {
    guidedStepRef.current = 0; guidedShotsRef.current = 0; guidedSigRef.current = null;
    setGuidedProgress({ step: 0, shots: 0 });
    dirStateRef.current = { dir: null, target: null, refDist: Infinity, lastSpeak: 0, arrived: false };
  }, []);

  const resetSession = useCallback(() => {
    const total = geomRef.current.totalCells;
    setCounts(new Array(total).fill(0));
    cellTiltsRef.current = Array.from({ length: total }, () => []);
    prevCornersRef.current = null;
    lastDetSeqRef.current = -1;
    dwellStartRef.current = 0;
    maxSharpRef.current = 0;
    resetGuided();
  }, [resetGuided]);

  // A new dataset folder is a new capture session.
  useEffect(() => { resetSession(); }, [datasetPath, resetSession]);
  // Switching capture mode restarts the checklist.
  useEffect(() => { resetGuided(); }, [mode, resetGuided]);

  // Serialise every capture — auto and manual alike — through one lock, so a
  // space-bar snap can never interleave with an auto-snap mid-flight.
  const withSnapLock = useCallback(async (fn) => {
    if (snapInFlightRef.current) return null;
    snapInFlightRef.current = true;
    try { return await fn(); } finally { snapInFlightRef.current = false; }
  }, []);

  // Tally the just-snapped frame into the live coverage. Only cells the board
  // actually filled (≥ CAPTURE_MIN_CORNERS corners) are incremented, so coverage
  // reflects deliberate captures — not the live board sweeping past.
  const markFromManualSnap = useCallback(({ silent = false } = {}) => {
    const meta = latestMetaRef.current;
    const geom = geomRef.current;
    if (!meta?.corners?.length || !geom.extent) return;
    const perCell = geom.bin(meta.corners);
    const b = boardRef.current;
    const tilt = boardTiltDeg(meta.corners, b.cols, b.rows);
    // record this capture's tilt in every cell it covered, for orientation diversity
    if (tilt != null) {
      perCell.forEach((cnt, i) => { if (cnt >= CAPTURE_MIN_CORNERS) cellTiltsRef.current[i].push(tilt); });
    }
    setCounts(prev => {
      const next = prev.map((n, i) => n + (perCell[i] >= CAPTURE_MIN_CORNERS ? 1 : 0));
      // Spoken cues: a short "captured", and "coverage complete" the moment the
      // last cell crosses from empty to covered. Guided mode passes silent:true
      // and drives its own voice cadence (per-step, not per-cell).
      if (!silent) {
        sayRef.current?.('captured', 600);
        const wasFull = prev.every(n => n > 0);
        if (!wasFull && next.every(n => n > 0)) sayRef.current?.('allCovered');
      }
      return next;
    });
  }, []);

  // Advance the guided checklist by one banked shot. Auto-capture advances
  // inline in onMeta; this keeps manual (space-bar) snaps in guided mode in sync
  // so the overlay/HUD step doesn't stall while the user shoots by hand.
  const advanceGuidedShot = useCallback(() => {
    const step = GUIDED_STEPS[guidedStepRef.current];
    if (!step) return;
    const m = analyzeBoard(latestMetaRef.current?.corners, boardRef.current, geomRef.current.extent);
    const newShots = guidedShotsRef.current + 1;
    if (newShots >= step.shots) {
      guidedShotsRef.current = 0; guidedSigRef.current = null; guidedStepRef.current += 1;
      setGuidedProgress({ step: guidedStepRef.current, shots: 0 });
    } else {
      guidedShotsRef.current = newShots; guidedSigRef.current = shotSignature(m);
      setGuidedProgress({ step: guidedStepRef.current, shots: newShots });
    }
  }, []);

  // Decide whether to speak a steering cue this frame. Event-driven: speak on a
  // new target, a changed direction, drifting the wrong way, or a stall — and go
  // quiet while the board is closing in. `key` resets the progress baseline when
  // the thing we're steering toward changes.
  const steer = useCallback((curX, curY, target, key) => {
    const st = dirStateRef.current;
    if (st.target !== key) { st.target = key; st.dir = null; st.refDist = Infinity; }
    if (curX == null || !target) return;
    const geom = geomRef.current;
    const r = geom.extent ? Math.min(geom.extent.rx, geom.extent.ry) : 0;
    if (!r) return;
    const dx = target.x - curX, dy = target.y - curY;
    const dist = Math.hypot(dx, dy);
    let dir = geom.radialCue({ x: curX, y: curY }, target);
    if (!dir) {
      if (Math.abs(dx) > Math.abs(dy)) {
        const right = dx > 0;
        dir = (right !== mirrorRef.current) ? 'moveRight' : 'moveLeft';  // mirror swaps L/R
      } else dir = dy > 0 ? 'moveDown' : 'moveUp';
    }
    const now = performance.now();
    const eps = r * 0.06;
    const progressed = dist <= st.refDist - eps;
    const wrongWay = dist >= st.refDist + eps;
    let speakIt = false;
    if (dir !== st.dir) speakIt = now - st.lastSpeak > 900;        // new direction
    else if (wrongWay) speakIt = now - st.lastSpeak > 1500;        // drifting away
    else if (!progressed) speakIt = now - st.lastSpeak > 3500;     // stalled, no progress
    if (progressed) st.refDist = dist;                            // closing in → stay quiet
    if (speakIt) { sayRef.current?.(dir); st.dir = dir; st.refDist = dist; st.lastSpeak = now; }
  }, []);

  // Sweep-mode steering, which additionally announces arrival on the target cell
  // and only nags once the board is sitting on an already-full cell.
  const steerSweep = useCallback(({ cell, reason, curX, curY }) => {
    const guid = guidanceRef.current;
    const st = dirStateRef.current;
    if (st.target !== guid) { st.target = guid; st.dir = null; st.refDist = Infinity; st.arrived = false; }
    const geom = geomRef.current;
    if (guid == null || !geom.extent || cell == null) return;
    if (cell === guid) {                       // on the target cell
      if (!st.arrived) { st.arrived = true; sayRef.current?.('onTarget'); }
      return;
    }
    st.arrived = false;
    if (reason !== 'enough') return;           // only steer off an already-full cell
    const target = geom.cellCenter(guid);
    if (!target) return;
    steer(curX, curY, target, guid);
  }, [steer]);

  const runAutoSnap = useCallback((after) => {
    const now = performance.now();
    lastAutoSnapRef.current = now;
    dwellStartRef.current = 0;
    withSnapLock(async () => {
      try {
        const r = await doSnapRef.current();
        if (cancelledRef.current || !r) return;
        after(r);
      } catch (e) {
        if (cancelledRef.current) return;
        setStatusRef.current?.(tRef.current('common.autoSnapFailed', { error: e.message }), true);
      }
    });
  }, [withSnapLock]);

  const onMeta = useCallback((meta) => {
    // Always stash the freshest meta so a manual snap can bin its corners, even
    // when auto-capture is off.
    latestMetaRef.current = meta;
    const corners = meta?.corners;
    const size = meta?.image_size;
    const geom = geomRef.current;
    const t = tRef.current;

    if (!enabledRef.current || !deviceRef.current || !datasetRef.current) { dwellStartRef.current = 0; return; }
    // The backend streams video faster than it detects, so the same detection
    // arrives on several frames. Run the capture/motion logic only on a FRESH
    // detection, else a moving board's repeated corners read as "still".
    if (meta?.det_seq != null && meta.det_seq === lastDetSeqRef.current) return;
    lastDetSeqRef.current = meta?.det_seq ?? lastDetSeqRef.current;
    const now = performance.now();

    // No full board in view → nothing to do; reset the dwell.
    if (!corners || corners.length < 4 || !size) {
      prevCornersRef.current = null; dwellStartRef.current = 0;
      setAutoHud({ reason: 'noBoard', dwell: 0 });
      return;
    }

    // 1) Motion: mean per-corner displacement vs the previous frame.
    const prev = prevCornersRef.current;
    let motion = Infinity;
    if (prev && prev.length === corners.length) {
      let s = 0;
      for (let i = 0; i < corners.length; i++) {
        s += Math.hypot(corners[i][0] - prev[i][0], corners[i][1] - prev[i][1]);
      }
      motion = s / corners.length;
    }
    prevCornersRef.current = corners;
    const motionThresh = Math.max(2, size[0] * 0.004);  // ≈ 3.8 px @ 960 wide
    const still = motion < motionThresh;

    // 2) Sharpness: adaptive — must be within SHARP_REL of the session best.
    const sharp = typeof meta.sharpness === 'number' ? meta.sharpness : null;
    if (sharp != null) maxSharpRef.current = Math.max(maxSharpRef.current, sharp);
    const sharpOk = sharp == null
      || sharp >= Math.max(SHARP_ABS, maxSharpRef.current * SHARP_REL);

    const b = boardRef.current;
    const extent = geom.extent;

    // ── Guided-sequence branch ────────────────────────────────────────────────
    // Doc-driven checklist: walk GUIDED_STEPS in order, two shots per action, the
    // 2nd required to differ a little from the 1st. Region + pose are matched
    // against the active step; we steer with voice/HUD until both are satisfied,
    // then dwell-snap. Shares the motion + sharpness gates above.
    if (modeRef.current === 'guided') {
      const debouncedG = now - lastAutoSnapRef.current >= Math.max(400, rateRef.current * 1000);
      const step = GUIDED_STEPS[guidedStepRef.current];
      if (!step) {                                  // whole sequence finished
        dwellStartRef.current = 0;
        setAutoHud({ reason: 'done', dwell: 0, guidedLabel: t('guided.done') });
        return;
      }
      const shots = guidedShotsRef.current;
      const m = analyzeBoard(corners, b, extent);
      const rOk = regionOk(step, m, extent);
      const pOk = poseOk(step, m, profileRef.current);
      const needVary = shots === 1 && !differsEnough(guidedSigRef.current, m, extent);

      let reason;
      if (!rOk) reason = 'region';
      else if (!pOk) reason = 'pose';
      else if (needVary) reason = 'vary';
      else if (!sharpOk) reason = 'blurry';
      else if (!still) reason = 'hold';
      else reason = 'capturing';

      // Voice steering: position first, then pose.
      if (!rOk) {
        steer(m.centroid?.x, m.centroid?.y, regionTarget(step.region, extent), step.id);
      } else if (!pOk) {
        sayRef.current?.('tiltHint', 4000);
      }

      const label = t('guided.progress', {
        step: guidedStepRef.current + 1, total: GUIDED_STEPS.length,
        group: t(`guided.groups.${step.group}`),
        action: t(`guided.steps.${step.id}`),
        shot: shots + 1, shots: step.shots,
      });

      const readyG = rOk && pOk && !needVary && sharpOk && still && debouncedG;
      if (!readyG || snapInFlightRef.current) {
        if (reason !== 'capturing') dwellStartRef.current = 0;
        setAutoHud({ reason, dwell: 0, tilt: m.tilt, guidedLabel: label });
        return;
      }
      if (dwellStartRef.current === 0) dwellStartRef.current = now;
      const heldG = now - dwellStartRef.current;
      setAutoHud({ reason: 'capturing', dwell: Math.min(1, heldG / DWELL_MS), tilt: m.tilt, guidedLabel: label });
      if (heldG < DWELL_MS) return;

      const sigNow = shotSignature(m);
      runAutoSnap((r) => {
        markFromManualSnap({ silent: true });   // feed the fallback coverage % silently
        const newShots = shots + 1;
        if (newShots >= step.shots) {           // step done → advance
          guidedShotsRef.current = 0;
          guidedSigRef.current = null;
          guidedStepRef.current += 1;
          const done = guidedStepRef.current >= GUIDED_STEPS.length;
          sayRef.current?.(done ? 'allCovered' : 'captured', 600);
          setGuidedProgress({ step: guidedStepRef.current, shots: 0 });
        } else {                                 // banked shot 1 → wait for a varied 2nd
          guidedShotsRef.current = newShots;
          guidedSigRef.current = sigNow;
          sayRef.current?.('captured', 600);
          setGuidedProgress({ step: guidedStepRef.current, shots: newShots });
        }
        setStatusRef.current?.(t('common.autoSnapped', {
          name: r.path.split('/').pop(), cell: guidedStepRef.current,
        }));
      });
      return;
    }

    // ── Sweep branch ──────────────────────────────────────────────────────────
    // 3) Novelty (corner-binned, to match the coverage tally): bin THIS board's
    //    corners into cells exactly like markFromManualSnap, instead of keying
    //    only on the cell its centroid sits in. A board pushed to the frame edge
    //    deposits corners into an empty edge cell even while its centroid stays
    //    mid-frame, so corner-in-cell rewards the edge shots that matter most.
    //    The target cell is the emptiest under-sampled cell the board actually
    //    fills (≥ CAPTURE_MIN_CORNERS corners), tie-broken toward the outside
    //    (higher flat index) — the hardest, most valuable ones.
    let sx = 0, sy = 0;
    for (const c of corners) { sx += c[0]; sy += c[1]; }
    const cenX = sx / corners.length, cenY = sy / corners.length;
    const centroidCell = geom.cellAt(cenX, cenY);
    const cnts = countsRef.current;
    const tilt = boardTiltDeg(corners, b.cols, b.rows);
    const perCell = geom.bin(corners);
    let cell = null, cellCount = TARGET_PER_CELL;
    for (let i = 0; i < perCell.length; i++) {
      if (perCell[i] < CAPTURE_MIN_CORNERS) continue;
      const n = cnts[i] ?? 0;
      if (n < TARGET_PER_CELL && (cell == null || n < cellCount || (n === cellCount && i > cell))) {
        cell = i; cellCount = n;
      }
    }
    // Tilt freshness is tracked against the target cell (or the centroid cell
    // when the board adds no new coverage), and judged against the MOST RECENT
    // capture in that cell — not every prior one. Comparing to all past tilts
    // means that once you've swept a range of angles, every new angle lands
    // within TILT_MIN_DIFF of *some* earlier capture and the gate locks up.
    const trackCell = cell != null ? cell : centroidCell;
    const tilts = trackCell != null ? cellTiltsRef.current[trackCell] : [];
    const lastTilt = tilts?.length ? tilts[tilts.length - 1] : null;
    const tiltFresh = tilt == null || lastTilt == null
      || Math.abs(lastTilt - tilt) >= TILT_MIN_DIFF;
    const underTarget = cell != null;     // set only when an under-target cell is filled
    const novel = underTarget && (cellCount === 0 || tiltFresh);

    // 4) Debounce after a snap, and never overlap an in-flight snap.
    const debounced = now - lastAutoSnapRef.current >= Math.max(400, rateRef.current * 1000);

    let reason;
    if (cell == null) reason = 'enough';                   // board adds no under-target coverage
    else if (!tiltFresh) reason = 'tilt';                  // need a different angle here
    else if (!sharpOk) reason = 'blurry';
    else if (!still) reason = 'hold';
    else reason = 'capturing';

    steerSweep({ cell: centroidCell, reason, curX: cenX, curY: cenY });

    const ready = novel && sharpOk && still && debounced;
    if (!ready || snapInFlightRef.current) {
      if (reason !== 'capturing') dwellStartRef.current = 0;
      if (reason === 'tilt') sayRef.current?.('tiltHint', 4000);
      setAutoHud({ reason, dwell: 0, tilt });
      return;
    }

    // 5) Dwell: hold the good pose for DWELL_MS before firing.
    if (dwellStartRef.current === 0) dwellStartRef.current = now;
    const held = now - dwellStartRef.current;
    setAutoHud({ reason: 'capturing', dwell: Math.min(1, held / DWELL_MS), tilt });
    if (held < DWELL_MS) return;

    runAutoSnap((r) => {
      markFromManualSnap();
      setStatusRef.current?.(t('common.autoSnapped', {
        name: r.path.split('/').pop(), cell: cell ?? 0,
      }));
    });
  }, [markFromManualSnap, runAutoSnap, steer, steerSweep]);

  // Turning auto-capture off clears the badge and any half-finished dwell.
  useEffect(() => {
    if (!enabled) { setAutoHud(null); dwellStartRef.current = 0; }
  }, [enabled]);

  return {
    onMeta, autoHud, counts, guidedProgress,
    resetSession, markFromManualSnap, advanceGuidedShot, withSnapLock,
  };
}
```

- [ ] **Step 2: 验证 hook 至少能被解析与构建**

Run: `npm run lint`
Expected: 无输出。（若 `react-hooks/exhaustive-deps` 对 `onMeta` 的依赖数组报 warn，按提示补齐 —— 上面列出的 `[markFromManualSnap, runAutoSnap, steer, steerSweep]` 已覆盖全部非 ref 引用。）

Run: `npm test && npm run build:renderer`
Expected: 测试仍全绿；build 成功（hook 暂无引用，Vite 不会打进产物，但语法错误会被 lint 抓到）

- [ ] **Step 3: 提交**

```bash
git add renderer/src/lib/smartCapture/useSmartCapture.js
git commit -m "feat(lib): 抽出共享的 useSmartCapture 自动拍摄状态机"
```

---

### Task 6: `FisheyeTab` 切到共享 hook

删掉页面里的状态机，改用 Task 5 的 hook。这是**行为不变**的替换 —— 任何取值差异都是 bug。

**Files:**
- Modify: `renderer/src/tabs/FisheyeTab.jsx`

**Interfaces:**
- Consumes: Task 4 的 `makePolarGeometry`；Task 5 的 `useSmartCapture`；Task 2 的 `FISHEYE_PROFILE`
- Produces: 无新导出

- [ ] **Step 1: 删除被 hook 取代的代码**

从 `FisheyeTab.jsx` 中删除：
- 常量 `CAPTURE_MIN_CORNERS` / `TARGET_PER_CELL` / `DWELL_MS` / `SHARP_REL` / `SHARP_ABS` / `TILT_MIN_DIFF`（原 26–36 行）
- 状态 `polarCounts` / `autoHud` / `guidedProgress` 及其 setter
- ref `latestMetaRef` / `lastAutoSnapRef` / `snapInFlightRef` / `prevCornersRef` / `lastDetSeqRef` / `dwellStartRef` / `maxSharpRef` / `cellTiltsRef` / `guidedStepRef` / `guidedShotsRef` / `guidedSigRef` / `captureModeRef` / `dirStateRef` / `covCircleRef` / `polarCountsRef` / `guidanceRef` / `snapCancelledRef` / `boardRef` / `mirrorRef`（`mirrorRef` 仅剩 localStorage 写入职责，见 Step 3）
- 函数 `resetGuided` / `steerVoice` / `guidedSteer` / `markCellsFromSnap` / `onAutoMeta` / `advanceGuidedShot`
- 两个 `useEffect`：重置 polarCounts 的那个（原 325–334 行）、`captureModeRef` 同步的那个（原 319–323 行）

- [ ] **Step 2: 接入 hook**

在 `covCircle` 的 `useMemo` 之后加：

```js
// The capture geometry: the polar dartboard laid over the detected image circle.
// Re-made whenever the circle moves so the state machine bins against the truth.
const geometry = useMemo(() => makePolarGeometry(covCircle), [covCircle]);
```

`coverage` 的 `useMemo` 保持两阶段逻辑不变，只把 `polarCounts` 换成 `capture.counts`。因为
`capture` 要在 `coverage` 之后才拿得到 `guidance`，先算 counts-only 的引导：

```js
// The cell to steer toward next. Only meaningful during capture — after a solve
// the coverage switches to residual-derived cells and guidance goes quiet.
const captureGuidance = useMemo(
  () => (result?.per_frame_residuals?.length ? null : geometry.pickGuidance(captureCounts)),
  [result, geometry, captureCounts],
);
```

这里有个先后顺序问题：`captureCounts` 来自 hook，而 hook 又要 `guidance`。用一个 ref 打破环 ——
hook 的 `guidance` prop 接受**上一帧**的值即可（它只驱动语音方向，不影响判定）：

```js
const guidanceRef = useRef(null);
const capture = useSmartCapture({
  enabled: autoCapture,
  liveDevice, datasetPath, autoRate,
  board, geometry, profile: FISHEYE_PROFILE,
  mode: captureMode === 'guided' ? 'guided' : 'sweep',
  mirror,
  guidance: guidanceRef.current,
  doSnap: snapOnce,
  say, t, setStatus,
});
const captureCounts = capture.counts;
// …coverage / captureGuidance 的 useMemo 放在这之后…
useEffect(() => { guidanceRef.current = coverage.guidance; }, [coverage.guidance]);
```

> 注：`guidance` 通过 ref 传入，所以 hook 拿到的是上一次渲染的值。这与重构前
> 一致 —— 原来的 `guidanceRef` 也是在 `useEffect` 里滞后一帧同步的。

`snapOnce` 是页面提供的「抓一帧」，从原 `onAutoMeta` 里的 async 块提炼：

```js
// One capture: save the frame, make it undoable, refresh the strip. The snap
// lock and all coverage/voice bookkeeping live in useSmartCapture.
const snapOnce = useCallback(async () => {
  const r = await api.snap(liveDevice, datasetPath);
  pushUndo({ kind: 'snap', path: r.path });
  const files = await refreshDataset();
  if (files) setSelected(files.length);
  return r;
}, [liveDevice, datasetPath]);
```

- [ ] **Step 3: 改剩下的引用点**

- `captureMode` 的 `useEffect` 只保留 localStorage 写入：

```js
useEffect(() => { localStorage.setItem('calib_fisheye_capmode', captureMode); }, [captureMode]);
```

- `mirror` 的 `useEffect` 同样只保留 localStorage 写入（`mirrorRef` 已移入 hook）：

```js
useEffect(() => { localStorage.setItem('calib_fisheye_mirror', mirror ? '1' : '0'); }, [mirror]);
```

- `coverage` 的 `useMemo`：`polarCounts` → `capture.counts`，`pickGuidanceCell(polarCounts)` → `geometry.pickGuidance(capture.counts)`。
- `onSnap` 改为走 hook 的锁：

```js
const onSnap = async () => {
  let dir = datasetPath;
  if (!dir) {
    const picked = await pickFolder();
    if (!picked) { setStatus(t('common.pickSessionFolder'), true); return; }
    setDatasetPath(picked);
    dir = picked;
  }
  if (!liveDevice) { setStatus(t('common.pickCamera'), true); return; }
  const guided = captureMode === 'guided';
  await capture.withSnapLock(async () => {
    try {
      const r = await api.snap(liveDevice, dir);
      pushUndo({ kind: 'snap', path: r.path });
      capture.markFromManualSnap({ silent: guided });
      if (guided) { capture.advanceGuidedShot(); say('captured', 600); }
      setStatus(t('common.snapped', { name: r.path.split('/').pop() }));
      // Refresh the listing but keep the live view in the cell — the user is
      // mid-capture and shouldn't have the frame jump to the just-saved still.
      if (dir === datasetPath) await refreshDataset();
    } catch (e) {
      setStatus(t('common.snapFailed', { error: e.message }), true);
    }
  });
};
```

- `<LiveDetectedFrame … onMeta={onAutoMeta}` → `onMeta={capture.onMeta}`
- `guidedProgress.step` → `capture.guidedProgress.step`
- HUD 那段 `autoHud` → `capture.autoHud`
- `CaptureControls` 的 `onAuto`：去掉 `setAutoHud(null); dwellStartRef.current = 0;`（hook 已处理），只留 `setAutoCapture(v); if (v) setLiveDetect(true);`
- import 段加：

```js
import { makePolarGeometry } from '../lib/smartCapture/geometry.js';
import { useSmartCapture } from '../lib/smartCapture/useSmartCapture.js';
import { GUIDED_STEPS, FISHEYE_PROFILE } from '../lib/guidedSequence.js';
```
并删掉不再用到的 `binPolar` / `pickGuidanceCell` / `polarCellAt` / `polarCellGeometry` / `boardTiltDeg` / `analyzeBoard` / `regionTarget` / `regionOk` / `poseOk` / `differsEnough` / `shotSignature` / `extentFromCircle` import。

- Task 8 会把 `fisheye.guided.*` 的键改到 `guided.*`；本任务里 hook 已经用 `t('guided.…')`，所以**必须**和 Task 8 一起才能看到正确文案。先按 Task 8 的键名写，Task 8 落地前引导模式的 HUD 会显示键名 —— 这是预期的中间状态。

- [ ] **Step 4: 验证**

Run: `npm test && npm run lint && npm run build:renderer`
Expected: 全绿

- [ ] **Step 5: 手工回归（必做，无法自动化）**

1. `npm run dev`，切到鱼眼页，接一路相机，勾「实时检测」+「自动采集」。
2. 扫覆盖模式：把板在画面里扫一圈，确认 —— 靶盘随抓拍变绿、HUD 原因文案随姿态切换（未见标定板 / 太模糊 / 稳住 / 采集中 / 该区域已采够 / 换个倾斜角度）、停留进度条走满才拍、语音方向正确。
3. 引导模式：确认目标板形动画、姿态图示、转向箭头、步骤按 2 张一组推进。
4. 空格手动抓拍：确认与自动抓拍不打架、引导模式下步骤也推进。

- [ ] **Step 6: 提交**

```bash
git add renderer/src/tabs/FisheyeTab.jsx
git commit -m "refactor(fisheye): 自动拍摄状态机切到共享的 useSmartCapture"
```

---

### Task 7: `LiveDetectedFrame` 支持 `guidedExtent`

让引导叠加能在没有图像圆的针孔画面上工作，并省掉针孔上无意义的圆检测。

**Files:**
- Modify: `renderer/src/components/LiveDetectedFrame.jsx`

**Interfaces:**
- Consumes: Task 1 的 `extentFromCircle`；Task 2 的 `targetHalfSize(step, extent, cols, rows)` / `regionTarget(region, extent)` / `boardScale(corners, cols, rows, extent)`
- Produces: 新 prop `guidedExtent`（`{cx,cy,rx,ry} | null`）—— 传了就用它并跳过圆检测；不传则维持自动检测

- [ ] **Step 1: 加 prop 并接进 covRef**

在参数列表里 `onCircle` 之后加：

```js
  // Explicit region geometry for the guided overlay, as {cx, cy, rx, ry}. When
  // given we use it and skip circle auto-detection entirely — a pinhole frame
  // has no dark border, so detectCircleFromImageData would return a meaningless
  // disk, and running it costs a full-frame getImageData every 1.2s.
  guidedExtent = null,
```

`covRef` 的 `useEffect` 里加 `guidedExtent`，并把它加进依赖数组：

```js
      showPolar: showPolarGrid, polarCells, polarCounts, polarGuidance, target: polarTarget, rings, sectors,
      guided, guidedExtent,
    };
  }, [coverageCells, coverageCounts, fovMask, covCols, covRows, showCoverageGrid, showFootprint,
      showPolarGrid, polarCells, polarCounts, polarGuidance, polarTarget, rings, sectors, guided, guidedExtent]);
```

- [ ] **Step 2: 圆检测改为按需**

把 draw 里的检测门（原 300 行）改成：

```js
      // ── Auto-detect the fisheye image circle (throttled, from the clean frame
      // BEFORE any overlay is painted). Skipped when the caller supplied an
      // explicit guidedExtent and no polar dartboard is being drawn. ──────────
      if (cov?.showPolar || (cov?.guided && !cov.guidedExtent)) {
```

（函数体不变。）

- [ ] **Step 3: 引导叠加改吃 extent**

把原 518 行的 `if (cov?.guided && circleRef.current?.circle) {` 及其内部替换为：

```js
      if (cov?.guided) {
        const extent = cov.guidedExtent || extentFromCircle(circleRef.current?.circle);
        if (extent) {
        const g = cov.guided;
        // Region boundary (dashed, faint) — the fisheye image circle, or the
        // pinhole frame's inscribed ellipse. Matches the doc figures.
        ctx.save();
        ctx.setLineDash([cornerR * 2, cornerR * 2]);
        ctx.strokeStyle = 'oklch(0.85 0.03 230 / 0.4)';
        ctx.lineWidth = Math.max(1, cornerR * 0.3);
        ctx.beginPath();
        ctx.ellipse(extent.cx, extent.cy, extent.rx, extent.ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        if (!g.done) {
          const tgt = regionTarget(g.region, extent);
          const ts = tgt ? targetHalfSize(g, extent, bCols, bRows) : null;
          // live board centroid + outer quad (only a full detection has the quad)
          let cenX = null, cenY = null, quad = null;
          if (corners.length) {
            let sx = 0, sy = 0;
            for (const [x, y] of corners) { sx += x; sy += y; }
            cenX = sx / corners.length; cenY = sy / corners.length;
            const nb = bCols * bRows;
            if (corners.length >= nb) {
              quad = [corners[0], corners[bCols - 1], corners[nb - 1], corners[bCols * (bRows - 1)]];
            }
          }

          if (tgt && ts) {
            drawTargetBoard(ctx, tgt.x, tgt.y, ts.halfW, ts.halfH, g, cornerR, phase);
            // reinforce poses the rect shape doesn't already convey (frontal / near-far)
            if (g.pose === 'frontal' || g.pose === 'dist') {
              drawGuidedGlyph(ctx, tgt.x, tgt.y, Math.min(ts.halfW, ts.halfH), g.glyph, cornerR, phase);
            }
            // marching "go here" arrow while the board is away from the target zone
            if (cenX != null && Math.hypot(cenX - tgt.x, cenY - tgt.y) > tgt.acceptR) {
              drawSteerArrow(ctx, cenX, cenY, tgt.x, tgt.y, cornerR, phase);
            }
          }

          // Live board outline, tinted by ABSOLUTE frame-fill quality (doc §3):
          // green when it occupies a good fraction of the region, amber when too
          // big (outer corners get clipped) or too small (corners blur), blue in
          // between. Validated on the /tmp/1 + /tmp/4 fisheye sample sets.
          if (quad) {
            const sc = boardScale(corners, bCols, bRows, extent);
            let qc = 'oklch(0.8 0.16 235 / 0.95)';                       // blue: detected, transitional size
            if (sc != null) {
              if (sc > 0.66 || sc < 0.24) qc = 'oklch(0.72 0.18 35 / 0.95)';        // 太大/太小
              else if (sc >= 0.30 && sc <= 0.60) qc = 'oklch(0.78 0.16 150 / 0.95)'; // 合适
            }
            drawBoardQuad(ctx, quad, qc, cornerR);
          } else if (cenX != null) {
            ctx.fillStyle = 'oklch(0.8 0.16 235 / 0.95)';
            ctx.beginPath(); ctx.arc(cenX, cenY, cornerR * 2.2, 0, Math.PI * 2); ctx.fill();
          }
        }
        }
      }
```

顶部 import 加 `extentFromCircle`：

```js
import { extentFromCircle } from '../lib/boardMetrics.js';
```

- [ ] **Step 4: 验证**

Run: `npm test && npm run lint && npm run build:renderer`
Expected: 全绿

手工：鱼眼引导模式再跑一遍，确认虚线圆、目标板形、箭头与 Task 6 后一致（`rx===ry` 时 `ellipse` 画出来就是圆）。

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/LiveDetectedFrame.jsx
git commit -m "feat(preview): 引导叠加支持显式 guidedExtent, 针孔跳过圆检测"
```

---

### Task 8: i18n —— `guided.*` 提升 + `intrinsics.*` 补键

**Files:**
- Modify: `renderer/src/i18n/en.json`
- Modify: `renderer/src/i18n/zh.json`
- Modify: `renderer/src/tabs/FisheyeTab.jsx`（`fisheye.guided.*` → `guided.*`）

**Interfaces:**
- Consumes: 无
- Produces: 顶层 `guided.*` 命名空间；`intrinsics.*` 的 22 个新键

- [ ] **Step 1: 把 `guided` 块提到顶层**

`en.json` 与 `zh.json`：把 `fisheye.guided`（整个对象，含 `progress` / `done` / `groups` / `steps` / `hint`）原样剪切为**顶层** `guided` 键。内容一字不改。

`FisheyeTab.jsx` 里剩余的 `t('fisheye.guided.…')` 全部改为 `t('guided.…')`。
（Task 6 之后页面里应只剩 `guidedOverlay` 附近可能残留的引用 —— 用 `grep -n "fisheye.guided" renderer/src` 确认清零。）

- [ ] **Step 2: 给 `intrinsics` 补键**

`en.json` 的 `intrinsics` 对象里加：

```json
"perFrameErrHint": "this frame's reprojection error (pixels)",
"noCalibrationYet": "no calibration yet",
"viewCompare": "compare methods",
"mirror": "mirror",
"footprint": "footprint",
"coverageGrid": "coverage grid",
"captureModeSweep": "coverage grid",
"captureModeGuided": "guided steps",
"autoCapture": "auto-capture",
"auto_noBoard": "no board in view",
"auto_enough": "region already covered",
"auto_tilt": "tilt to a new angle",
"auto_blurry": "too blurry — hold steady",
"auto_hold": "hold still…",
"auto_capturing": "capturing…",
"auto_region": "move to the target spot",
"auto_pose": "adjust the pose",
"auto_vary": "nudge slightly, then shoot",
"auto_done": "all done",
"liveSuffix": "{{label}} · live",
"undistortedRemapFull": "undistorted · initUndistortRectifyMap + remap",
"undistortedUndistortFull": "undistorted · cv2.undistort",
"algo": "cv2.calibrateCamera · Levenberg-Marquardt",
"loadedDetail": "loaded ({{fmt}}) ← {{name}} · rms {{rms}} · fx {{fx}}",
"voicePlayFailed": "voice playback blocked ({{name}}): {{error}}"
```

`zh.json` 的 `intrinsics` 对象里加：

```json
"perFrameErrHint": "该帧重投影误差（像素）",
"noCalibrationYet": "尚未标定",
"viewCompare": "对比方法",
"mirror": "镜像",
"footprint": "检测足迹",
"coverageGrid": "覆盖网格",
"captureModeSweep": "扫覆盖",
"captureModeGuided": "文档引导",
"autoCapture": "自动采集",
"auto_noBoard": "未见标定板",
"auto_enough": "该区域已采够",
"auto_tilt": "换个倾斜角度",
"auto_blurry": "太模糊，请稳住",
"auto_hold": "稳住…",
"auto_capturing": "采集中…",
"auto_region": "移到目标位置",
"auto_pose": "调整姿态",
"auto_vary": "微调一点再拍",
"auto_done": "全部完成",
"liveSuffix": "{{label}} · 实时",
"undistortedRemapFull": "去畸变 · initUndistortRectifyMap + remap",
"undistortedUndistortFull": "去畸变 · cv2.undistort",
"algo": "cv2.calibrateCamera · Levenberg-Marquardt",
"loadedDetail": "已加载（{{fmt}}）← {{name}} · rms {{rms}} · fx {{fx}}",
"voicePlayFailed": "语音播放被拦截（{{name}}）：{{error}}"
```

- [ ] **Step 3: 验证**

Run: `npm run i18n:check`
Expected: `i18n key parity OK — N keys in both en.json and zh.json`

Run: `grep -rn "fisheye\.guided" renderer/src`
Expected: 无输出

Run: `npm test && npm run lint && npm run build:renderer`
Expected: 全绿

手工：鱼眼引导模式再看一眼 HUD，文案应恢复正常（不是键名）。

- [ ] **Step 4: 提交**

```bash
git add renderer/src/i18n/en.json renderer/src/i18n/zh.json renderer/src/tabs/FisheyeTab.jsx
git commit -m "i18n: guided.* 提升为共享命名空间, intrinsics.* 补采集相关键"
```

---

### Task 9: `CoverageGrid` 支持引导高亮

侧栏的矩形覆盖小图要能像极坐标靶盘一样把「下一个该补的格子」标成琥珀色。

**Files:**
- Modify: `renderer/src/components/panels.jsx`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CoverageGrid` 新增 prop `guidance = null`（格子索引）与 `counts = null`（用于绿色深浅）
  - `CaptureControls` 新增 prop `coverageCounts = null` / `coverageGuidance = null`，转发给 `CoverageGrid`

- [ ] **Step 1: 改 `CoverageGrid`**

把签名与 `cellFill` 改为：

```js
export function CoverageGrid({
  cells, counts = null, meanErr = null, mask = null, guidance = null,
  okBelow = 0.25, warnBelow = 0.5, w = 110, h = 72,
}) {
  const cols = 8, rows = 5;
  const cellFill = (on, idx) => {
    // Outside the FOV — never coverable, so render as N/A, not "missing".
    if (mask && !mask[idx]) return { fill: 'var(--text-4)', opacity: 0.18, na: true };
    // The cell to fill next — amber, so it reads the same as the on-frame target.
    if (idx === guidance) return { fill: 'var(--warn)', opacity: 0.55 };
    if (!on) return { fill: 'transparent', opacity: 1 };
    const e = meanErr?.[idx];
    if (e != null) {
      const color = e < okBelow ? 'var(--ok)' : e < warnBelow ? 'var(--warn)' : 'var(--err)';
      return { fill: color, opacity: 0.5 };
    }
    // During capture: deepen with the number of captures, like the dartboard.
    const n = counts ? counts[idx] : 1;
    return { fill: 'var(--accent)', opacity: Math.min(0.6, 0.3 + (n - 1) * 0.1) };
  };
```

（`return (<svg …>` 之后的 JSX 不变。）

- [ ] **Step 2: 改 `CaptureControls` 转发**

签名里加两个 prop，并把它们传给 `CoverageGrid`：

```js
  coverage, coverageCells, coverageCounts = null, coverageMeanErr = null,
  coverageMask = null, coverageGuidance = null, okBelow, warnBelow,
```

```js
          : <CoverageGrid cells={coverageCells} counts={coverageCounts} meanErr={coverageMeanErr}
                mask={coverageMask} guidance={coverageGuidance}
                okBelow={okBelow} warnBelow={warnBelow}/>}
```

底部的提示语也让矩形模式能显示「往高亮格子挪」：

```js
            {(polar && polar.guidance != null) || coverageGuidance != null
              ? t('panels.captureGuide')
              : <>{t('panels.captureMoreLine1')}<br/>{t('panels.captureMoreLine2')}</>}
```

- [ ] **Step 3: 验证并提交**

Run: `npm test && npm run lint && npm run build:renderer`
Expected: 全绿。鱼眼页侧栏靶盘外观不应有任何变化（它走 `polar` 分支）。

```bash
git add renderer/src/components/panels.jsx
git commit -m "feat(panels): CoverageGrid 支持引导高亮与采集深浅"
```

---

### Task 10: `IntrinsicsTab` 接入智能采集

**Files:**
- Modify: `renderer/src/tabs/IntrinsicsTab.jsx`

**Interfaces:**
- Consumes: Task 3 的 `computeCoverage`；Task 4 的 `makeRectGeometry`；Task 5 的 `useSmartCapture`；Task 2 的 `GUIDED_STEPS` / `PINHOLE_PROFILE`；Task 7 的 `guidedExtent`；Task 8 的 i18n 键；Task 9 的 `coverageCounts` / `coverageGuidance`
- Produces: 无新导出

- [ ] **Step 1: 换签名、加 import、加状态**

签名：

```js
export function IntrinsicsTab({ active, tweaks }) {
```

import 段追加：

```js
import { computeCoverage } from '../lib/coverage.js';   // 已有，删掉 cellIndexFor
import { extentFromImageSize } from '../lib/boardMetrics.js';
import { GUIDED_STEPS, PINHOLE_PROFILE } from '../lib/guidedSequence.js';
import { makeRectGeometry } from '../lib/smartCapture/geometry.js';
import { useSmartCapture } from '../lib/smartCapture/useSmartCapture.js';
import { speak } from '../lib/voice.js';
import { useVoiceCommands } from '../lib/voiceControl.js';
```

新状态（放在既有 `useState` 之后）：

```js
// 二选一的自动检测/叠加模式：'sweep' 矩形覆盖网格（手持扫覆盖），
// 'guided' 文档引导序列（按手册清单逐个位置/动作各拍两张）。跨会话记住。
const [captureMode, setCaptureMode] = useState(() => localStorage.getItem('calib_intrinsics_capmode') || 'sweep');
const guidedMode = captureMode === 'guided';
const [showFootprint, setShowFootprint] = useState(false);   // 检测可达足迹热力
// 镜像翻转：仅用于实时预览画面，不影响抓拍帧/校正视图/保存的原图。
const [mirror, setMirror] = useState(() => localStorage.getItem('calib_intrinsics_mirror') === '1');

useEffect(() => { localStorage.setItem('calib_intrinsics_capmode', captureMode); }, [captureMode]);
useEffect(() => { localStorage.setItem('calib_intrinsics_mirror', mirror ? '1' : '0'); }, [mirror]);
```

- [ ] **Step 2: 语音**

在 `setStatus` 定义之后加（与鱼眼同构）：

```js
// Voice prompts (Edge-TTS clips, Chinese). Gated by settings; the per-snap
// "captured" cue is rate-limited so rapid auto-captures don't stutter the audio.
const voicePrompts = !!tweaks?.voicePrompts;
const lastSpokeRef = useRef({});
const voiceErrRef = useRef('');
const say = useCallback((name, minGapMs = 0) => {
  if (!voicePrompts) return;
  const now = performance.now();
  if (minGapMs && now - (lastSpokeRef.current[name] || 0) < minGapMs) return;
  lastSpokeRef.current[name] = now;
  speak(name).catch((e) => {
    // AbortError ("play() interrupted by a new load request") is EXPECTED: a
    // newer cue intentionally cut this one off (one shared <audio>). Only
    // surface genuine blocks, de-duped so a persistent block doesn't overwrite
    // the status bar on every cue.
    if (e?.name === 'AbortError') return;
    const msg = e?.message || e?.name || 'play blocked';
    if (msg === voiceErrRef.current) return;
    voiceErrRef.current = msg;
    setStatus(t('intrinsics.voicePlayFailed', { name, error: msg }), true);
  });
}, [voicePrompts, t]);
```

语音指令（放在 `onRunRef` 等 ref 定义之后）：

```js
const onRunRef = useRef(null);
const lastVoiceCommandRef = useRef({ command: '', ts: 0 });

const acceptVoiceCommand = useCallback((command) => {
  const now = performance.now();
  const last = lastVoiceCommandRef.current;
  if (last.command === command && now - last.ts < 1200) return false;
  lastVoiceCommandRef.current = { command, ts: now };
  return true;
}, []);

const voiceHandlers = useMemo(() => ({
  calibrate: () => { if (acceptVoiceCommand('calibrate')) onRunRef.current?.(); },
  photo: () => { if (acceptVoiceCommand('snap')) onSnapRef.current?.(); },
  capture: () => { if (acceptVoiceCommand('snap')) onSnapRef.current?.(); },
}), [acceptVoiceCommand]);

useVoiceCommands(active === 'intrinsics' && !!tweaks?.voiceCommands, voiceHandlers);
```

并补一行 `useEffect(() => { onRunRef.current = onRun; });`（挨着已有的三个 ref 同步）。

- [ ] **Step 3: 几何 + hook + 两阶段覆盖**

替换原来的 `coverage` `useMemo`：

```js
// The region the capture grid is laid over: the whole frame. A pinhole lens has
// no image circle to detect, so this comes straight from the stream/solve size.
const imgSizeForCov = result?.image_size
  || (streamInfo?.open ? [streamInfo.width, streamInfo.height] : null);
const geometry = useMemo(() => makeRectGeometry(imgSizeForCov), [imgSizeForCov?.[0], imgSizeForCov?.[1]]);
const guidedExtent = useMemo(() => extentFromImageSize(imgSizeForCov), [imgSizeForCov?.[0], imgSizeForCov?.[1]]);

// `guidance` reaches the state machine one render late (it only drives the
// spoken direction, never a capture decision) — this ref breaks the cycle
// between "counts feed coverage" and "coverage feeds guidance".
const guidanceRef = useRef(null);

const snapOnce = useCallback(async () => {
  const r = await api.snap(liveDevice, datasetPath);
  pushUndo({ kind: 'snap', path: r.path });
  const files = await refreshDataset();
  if (files) setSelected(files.length);
  return r;
}, [liveDevice, datasetPath]);

const capture = useSmartCapture({
  enabled: autoCapture,
  liveDevice, datasetPath, autoRate,
  board, geometry, profile: PINHOLE_PROFILE,
  mode: guidedMode ? 'guided' : 'sweep',
  mirror,
  guidance: guidanceRef.current,
  doSnap: snapOnce,
  say, t, setStatus,
});

// Coverage. Two sources, picked by phase:
//   • after a solve → bin the per-frame residuals into the grid, which also
//     yields per-cell quality (mean reprojection error) for colouring.
//   • during capture → the live capture tally, so the grid fills in real time as
//     the user snaps. `guidance` flags the emptiest cell.
const coverage = useMemo(() => {
  if (result?.per_frame_residuals?.length) {
    return { ...computeCoverage(result.per_frame_residuals, result.image_size), guidance: null };
  }
  const cells = capture.counts.map(c => c > 0);
  const filled = cells.reduce((n, on) => n + (on ? 1 : 0), 0);
  const total = geometry.totalCells;
  return {
    cells, counts: capture.counts, meanErr: null, mask: null,
    guidance: geometry.pickGuidance(capture.counts),
    filled, total, percent: Math.round((filled / total) * 100),
  };
}, [result, capture.counts, geometry]);

useEffect(() => { guidanceRef.current = coverage.guidance; }, [coverage.guidance]);
```

并把 `useCameraSource` 的解构改为 `const { liveDevice, streamInfo } = cam;`。

- [ ] **Step 4: 删掉旧的朴素自动拍摄**

删除 `snappedCellsRef` / `lastAutoSnapRef` / `autoSnapInFlightRef` 三个 ref、重置它们的 `useEffect`、以及整个 `onAutoMeta`（原 179–210 行）。

- [ ] **Step 5: 手动 `onSnap` 走锁 + 留在实时画面**

```js
const onSnap = async () => {
  let dir = datasetPath;
  if (!dir) {
    const picked = await pickFolder();
    if (!picked) { setStatus(t('common.pickSessionFolder'), true); return; }
    setDatasetPath(picked);
    dir = picked;
  }
  if (!liveDevice) { setStatus(t('common.pickCamera'), true); return; }
  await capture.withSnapLock(async () => {
    try {
      const r = await api.snap(liveDevice, dir);
      pushUndo({ kind: 'snap', path: r.path });
      capture.markFromManualSnap({ silent: guidedMode });
      if (guidedMode) { capture.advanceGuidedShot(); say('captured', 600); }
      setStatus(t('common.snapped', { name: r.path.split('/').pop() }));
      // Refresh the listing but keep the live view — the user is mid-capture and
      // shouldn't have the frame jump to the just-saved still. Click a thumbnail
      // in the FrameStrip to inspect a saved frame.
      if (dir === datasetPath) await refreshDataset();
    } catch (e) {
      setStatus(t('common.snapFailed', { error: e.message }), true);
    }
  });
};
```

- [ ] **Step 6: 引导叠加描述符 + 实时画面接线 + HUD**

在 `rawCell` 之前加：

```js
// Guided overlay descriptor for the live frame: the active step's region + pose
// glyph, or {done:true} once the checklist is exhausted. null in sweep mode.
const guidedStepNow = GUIDED_STEPS[capture.guidedProgress.step];
const guidedOverlay = guidedMode
  ? (guidedStepNow
      ? { region: guidedStepNow.region, glyph: guidedStepNow.glyph,
          pose: guidedStepNow.pose, scale: guidedStepNow.scale ?? null,
          group: guidedStepNow.group, done: false }
      : { done: true })
  : null;
```

`rawCell` 里的 `<LiveDetectedFrame …>` 改为：

```jsx
          <LiveDetectedFrame device={liveDevice} board={board}
              showCorners={showBoard} showOrigin={showOrigin}
              onMeta={capture.onMeta}
              coverageCells={coverage.cells}
              coverageCounts={coverage.counts}
              showCoverageGrid={!guidedMode}
              guided={guidedOverlay}
              guidedExtent={guidedExtent}
              showFootprint={showFootprint}
              mirror={mirror}/>
```

`<LivePreview device={liveDevice}/>` 改为 `<LivePreview device={liveDevice} mirror={mirror}/>`。

在 `rawCell` 的 `<div className="vp-corner-read">` 之前插入 HUD（与鱼眼同款）：

```jsx
      {showLive && liveDetect && autoCapture && capture.autoHud && (() => {
        const r = capture.autoHud.reason;
        const color = r === 'capturing' ? 'var(--ok)' : r === 'blurry' || r === 'noBoard' ? 'var(--warn)' : 'var(--text-2)';
        return (
          <div style={{
            position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(3,6,10,0.94)', border: `1.5px solid ${color}`, borderRadius: 7,
            padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 196,
            fontFamily: 'JetBrains Mono', fontSize: 12.5, fontWeight: 600, color: 'var(--text)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)',
            textShadow: '0 1px 3px rgba(0,0,0,0.9)',
          }}>
            {capture.autoHud.guidedLabel && (
              <div style={{ color: 'var(--text)', fontSize: 12, fontWeight: 700 }}>{capture.autoHud.guidedLabel}</div>
            )}
            <div><span style={{ color }}>⦿ {t('intrinsics.autoCapture')} · {t(`intrinsics.auto_${r}`)}</span>
              {typeof capture.autoHud.tilt === 'number' && <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>  ∠{capture.autoHud.tilt.toFixed(0)}°</span>}
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.18)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round((capture.autoHud.dwell || 0) * 100)}%`, background: 'var(--ok)', transition: 'width 80ms linear' }}/>
            </div>
          </div>
        );
      })()}
```

- [ ] **Step 7: 工具栏加模式切换 / 足迹 / 镜像**

在 `<Chk checked={liveDetect} …>` 之后插入：

```jsx
          <Seg value={captureMode} onChange={(v) => { setCaptureMode(v); setLiveDetect(true); }} options={[
            {value:'sweep',label:t('intrinsics.captureModeSweep')},
            {value:'guided',label:t('intrinsics.captureModeGuided')},
          ]}/>
          <Chk checked={showFootprint} onChange={(v) => { setShowFootprint(v); if (v) setLiveDetect(true); }}>{t('intrinsics.footprint')}</Chk>
          <Chk checked={mirror} onChange={setMirror}>{t('intrinsics.mirror')}</Chk>
```

- [ ] **Step 8: `CaptureControls` 传新 prop**

```jsx
          <CaptureControls
            autoCapture={autoCapture}
            onAuto={(v) => { setAuto(v); if (v) setLiveDetect(true); }}
            autoRate={autoRate}
            onAutoRate={setAutoRate}
            onSnap={onSnap} onDrop={onDrop}
            coverage={coverage.percent}
            coverageCells={coverage.cells}
            coverageCounts={coverage.counts}
            coverageMeanErr={coverage.meanErr}
            coverageMask={coverage.mask}
            coverageGuidance={coverage.guidance}
            okBelow={PX_OK} warnBelow={PX_WARN}/>
```

- [ ] **Step 9: 验证**

Run: `npm test && npm run lint && npm run build:renderer`
Expected: 全绿

- [ ] **Step 10: 手工验收**

1. 针孔页勾「实时检测」+「自动采集」，扫覆盖模式：覆盖网格随抓拍变绿、HUD 原因文案切换、停留进度条、侧栏小图同步、语音方向正确（含勾上镜像后左右互换）。
2. 切引导模式：目标板形/姿态图示/箭头出现，17 步按 2 张一组推进。
3. 空格手动抓拍：不跳帧、与自动不打架、引导模式下步骤推进。
4. 解算后：覆盖切到残差着色，引导高亮消失。

- [ ] **Step 11: 提交**

```bash
git add renderer/src/tabs/IntrinsicsTab.jsx
git commit -m "feat(intrinsics): 接入智能自动拍摄, 实时覆盖与引导序列"
```

---

### Task 11: `IntrinsicsTab` 视图杂项与存取打磨

**Files:**
- Modify: `renderer/src/tabs/IntrinsicsTab.jsx`

**Interfaces:**
- Consumes: Task 8 的 `intrinsics.viewCompare` / `liveSuffix` / `undistorted*Full` / `algo` / `loadedDetail` / `noCalibrationYet` / `perFrameErrHint`
- Produces: 无新导出

- [ ] **Step 1: `compare` 视图**

把 `rectCell` 的构造改为可复用的工厂（对照鱼眼的 `rectifiedCell`）：

```js
// Undistorted cell. Source picks itself: live mode + calibrated → live MJPEG
// undistorted; dataset frame selected + calibrated → that frame; else placeholder.
const undistortedCell = (m, label) => {
  const useLive = showLive && calibrated && liveDevice;
  let body;
  if (useLive) {
    body = <RectifiedLivePreview device={liveDevice} K={result.K} D={D}
              model="pinhole" alpha={alpha} method={m}/>;
  } else if (canRectifyFrame) {
    body = <RectifiedFrame path={selectedPath} K={result.K} D={D}
              model="pinhole" alpha={alpha} method={m}/>;
  } else if (calibrated) {
    body = emptyCell(t('intrinsics.connectOrSelectFrame'));
  } else {
    body = emptyCell(t('intrinsics.runToUndistort'));
  }
  return (
    <div className="vp-cell" key={m}>
      <span className="vp-label">{useLive ? t('intrinsics.liveSuffix', { label }) : label}</span>
      {body}
      <div className="vp-corner-read">
        <div>{t('intrinsics.method')} <b>{m === 'undistort' ? t('intrinsics.methodCvUndistort') : t('intrinsics.methodRemapFull')}</b></div>
        <div>{t('intrinsics.alpha')} <b>{alpha.toFixed(2)}</b></div>
      </div>
    </div>
  );
};

const rectCell = undistortedCell(method, t('intrinsics.undistorted'));
```

视图 `Seg` 加一项，并在 `compare` 下隐藏 method 选择：

```jsx
          <Seg value={view} onChange={setView} options={[
            {value:'split',label:t('intrinsics.viewSplit')},
            {value:'raw',label:t('intrinsics.viewRaw')},
            {value:'rect',label:t('intrinsics.viewRectified')},
            {value:'compare',label:t('intrinsics.viewCompare')},
          ]}/>
          {view !== 'compare' && view !== 'raw' && (
            <Seg value={method} onChange={setMethod} options={[
              {value:'remap',label:t('intrinsics.methodRemap')},{value:'undistort',label:t('intrinsics.methodUndistort')},
            ]}/>
          )}
```

分屏选择加 `compare` 分支：

```js
          } else if (view === 'compare') {
            cells = [
              undistortedCell('remap', t('intrinsics.undistortedRemapFull')),
              undistortedCell('undistort', t('intrinsics.undistortedUndistortFull')),
            ];
          } else if (view === 'raw') {
```

- [ ] **Step 2: 工具栏读数加分辨率 / fps**

```jsx
          <div className="read">
            {streamInfo?.open && (
              <>{streamInfo.width}×{streamInfo.height} · <b>{streamInfo.capture_fps?.toFixed(1) ?? '—'}</b> fps · </>
            )}
            {datasetFiles.length > 0 && <>{t('intrinsics.frame')} <b>#{selectedFrame.toString().padStart(2,'0')}</b> · </>}
            {result?.ok
              ? <>rms <b style={{color: trafficColor(rmsKind)}}>{rms.toFixed(3)}</b> px</>
              : busy ? <>{t('intrinsics.solvingShort')}</> : <>{t('intrinsics.notCalibrated')}</>}
          </div>
```

- [ ] **Step 3: `FrameStrip` 与 `SolverPanel`**

```jsx
        <FrameStrip frames={frames} selected={selectedFrame}
          onSelect={(id) => { setSelected(id); setViewMode('frame'); }}
          coverage={coverage.percent}
          errUnit=" px" errHint={t('intrinsics.perFrameErrHint')}/>
```

```jsx
          <SolverPanel
            iters={result?.iterations ?? 0}
            cost={result?.final_cost ?? 0} costUnit="px²"
            cond={0}
            algo={t('intrinsics.algo')}/>
```

- [ ] **Step 4: `onLoad` 保住结果 + 切 split/live + 详细状态**

在组件里加：

```js
// When onLoad sets datasetPath from a loaded calibration, the dataset-listing
// effect would normally clear the just-loaded result. This ref tells the effect
// "skip the result reset on the next listing — the result is fresh, not stale."
const skipResultResetRef = useRef(false);
```

dataset 监听的 `useEffect` 里，把 `setResult(null);` 换成：

```js
      if (skipResultResetRef.current) {
        // onLoad just brought a fresh calibration in tandem with this dataset
        // path; don't wipe it.
        skipResultResetRef.current = false;
      } else {
        setResult(null);
      }
```

`onLoad` 的尾段改为：

```js
      if (d.dataset_path && d.dataset_path !== datasetPath) {
        // Tell the dataset-listing effect not to clear the result we just set.
        skipResultResetRef.current = true;
        setDatasetPath(d.dataset_path);
      }
      // Snap the viewport into split + live so the user immediately sees the raw
      // camera + undistorted preview built from the just-loaded intrinsics.
      setView('split');
      setViewMode('live');
      const fmt = p.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      const fxRound = (d.K?.[0]?.[0])?.toFixed?.(1) ?? '?';
      const rmsRound = (d.rms ?? 0).toFixed(3);
      setStatus(t('intrinsics.loadedDetail', { fmt, name: p.split('/').pop(), rms: rmsRound, fx: fxRound }));
```

- [ ] **Step 5: `onRun` 加语音**

```js
    setBusy(true);
    setStatus(t('intrinsics.detectingSolving'));
    say('solveStart');
    try {
      const res = await api.calibrate('intrinsics', { board: boardPayload(), model, dataset_path: datasetPath });
      setResult(res);
      setStatus(res.ok
        ? t('intrinsics.rmsResult', { rms: res.rms.toFixed(4), message: res.message })
        : t('common.failed', { message: res.message }), !res.ok);
      say(res.ok ? 'solveOk' : 'solveFail');
    } catch (e) {
      setStatus(t('common.error', { error: e.message }), true);
      say('solveFail');
    } finally {
      setBusy(false);
    }
```

- [ ] **Step 6: 验证**

Run: `npm test && npm run lint && npm run build:renderer`
Expected: 全绿

- [ ] **Step 7: 手工验收**

1. `compare` 视图：remap 与 undistort 并排，标签正确。
2. 工具栏显示分辨率与 fps。
3. FrameStrip 悬浮显示「该帧重投影误差（像素）」，数字带 ` px`。
4. Load 一个已存的 intrinsics.yaml：结果不被清空、自动切 split+live、状态栏显示 fmt/名字/rms/fx。
5. 开启语音提示后运行标定：听到开始/成功（或失败）提示。
6. 语音指令（⚙ 里开启）：说「拍照」抓拍、说「标定」求解，且只在针孔页生效（切到鱼眼页不应触发针孔的 handler）。

- [ ] **Step 8: 提交**

```bash
git add renderer/src/tabs/IntrinsicsTab.jsx
git commit -m "feat(intrinsics): compare 视图, 镜像/足迹/读数与存取打磨"
```

---

## Self-Review

**Spec 覆盖核对**（对照 spec §2 的能力清单）：

| spec 项 | 落在 |
|---|---|
| A 智能自动拍摄 | Task 5（状态机）+ Task 10 Step 3–4 |
| B 拍摄期实时覆盖 | Task 3 + Task 9 + Task 10 Step 3/6/8 |
| C1 语音提示 | Task 5（steer/say 调用）+ Task 10 Step 2 |
| C2 语音指令 | Task 10 Step 2 |
| D 引导序列 | Task 2 + Task 5 guided 分支 + Task 7 + Task 10 Step 6/7 |
| E1 compare 视图 | Task 11 Step 1 |
| E2 镜像 | Task 10 Step 1/6/7 |
| E3 足迹 | Task 10 Step 1/6/7 |
| E4 分辨率 fps | Task 11 Step 2 |
| E5 FrameStrip 提示 | Task 11 Step 3 |
| F1 skipResultReset | Task 11 Step 4 |
| F2 Load 切 split/live | Task 11 Step 4 |
| F3 Snap 不跳帧 | Task 10 Step 5 |
| F4 Snap 锁 | Task 5 `withSnapLock` + Task 10 Step 5 |
| F5 SolverPanel algo | Task 11 Step 3 |
| F6 camera_intrix | 明确不做（Global Constraints） |
| spec §3.1 extent | Task 1 |
| spec §3.2 模块划分 | Task 1/2/3/4/5 |
| spec §3.3 适配器 + hook | Task 4 + Task 5 + Task 6 |
| spec §3.4 profile | Task 2 |
| spec §3.5 guidedExtent | Task 7 |
| spec §4 IntrinsicsTab | Task 10 + Task 11 |
| spec §5 i18n | Task 8 |
| spec §6 测试 + CI | Task 1 Step 1 + Task 1/2/3/4 的测试 |

无遗漏。

**类型一致性核对**：
- `extent` 一律 `{cx, cy, rx, ry}`，产出方 Task 1（`extentFromCircle` / `extentFromImageSize`），消费方 Task 2/4/7。
- 适配器七个字段（`kind` / `totalCells` / `extent` / `bin` / `cellAt` / `cellCenter` / `pickGuidance` / `radialCue`）在 Task 4 定义，Task 5 与 Task 6/10 按同名使用。
- `capture.*` 返回的八个字段在 Task 5 定义，Task 6 与 Task 10/11 按同名使用。
- `profile` 六个阈值字段名在 Task 2 定义，仅 `poseOk` 消费。
- i18n 键：Task 5 的 hook 用 `guided.*`（Task 8 建立）；Task 10 的 HUD 用 `intrinsics.auto_*` / `intrinsics.autoCapture`（Task 8 建立）。**Task 8 必须在 Task 10 之前完成** —— 计划顺序已满足。

**已知的中间态**（刻意为之，非缺陷）：
- Task 6 结束到 Task 8 完成之间，鱼眼引导模式的 HUD 会显示 `guided.progress` 这样的键名。Task 6 Step 3 末尾已注明。
- Task 5 结束时 hook 无调用方，Vite 不会打进产物；lint 与语法由 `npm run lint` 保证。
