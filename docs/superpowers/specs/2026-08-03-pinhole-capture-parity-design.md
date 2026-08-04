# 针孔标定页对齐鱼眼页的采集能力 — 设计

日期：2026-08-03
范围：`renderer/`（前端），不改 `backend/`

## 1. 背景与目标

`IntrinsicsTab`（Tab1，针孔）与 `FisheyeTab`（Tab2，鱼眼）是同一套标定工作流的两个相机模型分支。
鱼眼页在迭代中长出了一整套采集期辅助能力，针孔页停留在早期形态：

- 针孔的自动拍摄只判断「这个格子没拍过 + 距上次拍摄超过 N 秒」，会把糊的、抖的、角度重复的帧一并存进数据集。
- 针孔的覆盖率只在解算完成后由残差反推，采集过程中屏幕上没有任何覆盖反馈，操作员不知道还差哪里。
- 语音提示、语音指令、引导序列、镜像、足迹热力图、对比视图等鱼眼已有的能力，针孔完全没有。

**目标**：把鱼眼页相对针孔页多出的能力全部落到针孔页，其中依赖鱼眼专属几何（图像圆 / 极坐标靶盘）的部分改写为针孔适用的矩形形式。

**非目标**：
- 不改标定求解器与任何后端接口。
- 不移植 Save 时写入机器人 `camera_intrix.yaml` 的机位导出（后端 `export_camera_intrinsics` 把 `distortion_model` 硬编码为 `"fisheye"`，针孔写进去是错误元数据）。
- 不做与本目标无关的重构。

## 2. 能力差异清单

以下为 `FisheyeTab` 有而 `IntrinsicsTab` 没有的全部能力，均在本次范围内（F6 除外）：

| 编号 | 能力 | 现状 |
|---|---|---|
| A | 智能自动拍摄：清晰度门限、静止判定、每格目标张数、倾角多样性、停留计时、`det_seq` 去重、in-flight 锁 | 针孔仅有「新格子 + 限速」 |
| B | 拍摄期实时覆盖：拍一张累计一格、画在实时画面上、提示下一个该补的格子 | 针孔仅有解算后残差覆盖 |
| C1 | 语音提示：拍到了 / 覆盖完成 / 上下左右引导 / 解算开始·成功·失败 / 倾角提示 | 针孔无 |
| C2 | 语音指令：手机端「拍照」「标定」 | 针孔无 |
| D | 引导序列模式：按手册清单逐位置·姿态各拍 2 张，画面上有目标板形 + 姿态图示 + 转向箭头 | 针孔无 |
| E1 | `compare` 视图：remap 与 undistort 并排 | 针孔无 |
| E2 | 镜像翻转（仅实时预览，跨会话记住） | 针孔无 |
| E3 | 检测足迹热力图 | 针孔无 |
| E4 | 工具栏分辨率 / fps 读数 | 针孔无 |
| E5 | FrameStrip 误差单位与悬浮提示 | 针孔无 |
| F1 | Load 后不被 dataset 监听清空（`skipResultReset`） | 针孔 Load 后结果会被清掉 |
| F2 | Load 后自动切 split + live，状态栏显示 fmt/rms/fx | 针孔仅显示路径 |
| F3 | Snap 后停留在实时画面（不跳到刚存的静帧） | 针孔会跳帧 |
| F4 | Snap 的 in-flight 锁（防手动与自动竞争） | 针孔无 |
| F5 | SolverPanel 的 `algo` 标签 | 针孔无 |
| F6 | Save 时按 ROS2 话题识别机位写入 `camera_intrix.yaml` | **不移植**，见非目标 |

## 3. 架构

### 3.1 几何抽象：`circle` → `extent`

鱼眼的引导几何全部挂在自动检测的图像圆 `{cx, cy, r}` 上。针孔画面没有黑边，
`detectCircleFromImageData` 在其上会退化到 `edge = maxR` 并返回一个**语义错误的假圆**，
因此针孔不能走圆检测。

统一为 **extent**：

```js
{ cx, cy, rx, ry }
```

| 相机 | cx, cy | rx, ry | 来源 |
|---|---|---|---|
| 鱼眼 | 检测出的圆心 | `r, r` | `detectCircleFromImageData` |
| 针孔 | `w/2, h/2` | `w/2, h/2` | `image_size`，不做检测 |

**关键不变式**：鱼眼恒有 `rx === ry`，泛化后凡是原先用 `r` 的地方取 `rx`/`ry`/`min(rx,ry)`
在鱼眼下都退化回 `r`，因此鱼眼路径数值上完全不变。这是控制回归风险的核心手段，
并由 §6 的测试断言。

### 3.2 模块划分

新增与调整（`renderer/src/lib/`）：

```
lib/
  boardMetrics.js        新增 — 几何中立的板测量
  polarCoverage.js       瘦身 — 只留极坐标分箱 + 圆检测
  coverage.js            补充 — 矩形网格的 cellGeometry / pickGuidanceCell
  guidedSequence.js      泛化 — 区域/姿态判定改吃 extent + profile
  smartCapture/
    geometry.js          新增 — 适配器工厂
    useSmartCapture.js   新增 — 自动拍摄状态机（唯一一份）
```

各单元职责：

- **`boardMetrics.js`** — 从角点数组算板的几何量，不知道相机模型：
  `cornersCentroid` / `boardTiltDeg` / `boardRollDeg` / `boardScale(corners, cols, rows, extent)` / `analyzeBoard`。
  由 `polarCoverage.js`（现 `boardTiltDeg`）与 `guidedSequence.js`（现 `cornersCentroid`/`boardRollDeg`/`boardScale`/`analyzeBoard`）迁入。
  依赖：无。
- **`polarCoverage.js`** — 极坐标分箱与圆检测，鱼眼专属。移出 `boardTiltDeg` 后不再被 `guidedSequence` 依赖。
- **`coverage.js`** — 矩形网格分箱。补两个与极坐标同形的导出：
  `cellGeometry(imageSize, cols, rows)` 返回 `[{index, x, y}]`（格心，用于转向）；
  `pickGuidanceCell(counts, mask)` 返回最空的格子索引（并列时偏向靠边的格子，理由同鱼眼偏外环：边缘畸变最大最难补），全部非空则返回 `null`。
- **`guidedSequence.js`** — 「板该去哪、姿态对不对」。`GUIDED_STEPS` 与 `REGIONS` 不变，
  `regionTarget` / `regionOk` / `poseOk` / `differsEnough` / `shotSignature` 改吃 `extent` 与 `profile`。
  同时把现在私藏在 `LiveDetectedFrame.jsx` 里的 `targetHalfSize`（算目标板形的半宽半高，
  是纯几何）迁到这里并导出 —— 它属于「板该长什么样」，也才能被 §6 的测试覆盖。
- **`smartCapture/`** — 见 §3.3。

### 3.3 `useSmartCapture` 与几何适配器

**适配器契约**（状态机对几何的全部依赖）：

```js
{
  totalCells,                  // int
  extent,                      // {cx,cy,rx,ry} | null
  bin(corners),                // → int[totalCells]，单帧每格角点数
  cellAt(x, y),                // → idx | null
  cellCenter(idx),             // → {x, y} | null
  pickGuidance(counts),        // → idx | null
  radialCue(cur, target),      // → 'moveOut' | null
}
```

工厂：

- `makePolarGeometry(circle)` — 包装 `binPolar` / `polarCellAt` / `polarCellGeometry` / `pickGuidanceCell`。
  `radialCue` 在目标格半径显著大于当前半径时返回 `'moveOut'`（保持现有阈值 `0.33 * r`）。
- `makeRectGeometry(imageSize)` — 包装 `cellCornerCounts` / `cellIndexFor` / 新的 `cellGeometry` / `pickGuidanceCell`。
  `radialCue` 恒返回 `null`：矩形网格没有「环」的语义，转向退化为纯上下左右。
  针孔无渐晕，不使用 `fovCellMask`（全部格子有效）。

**hook 契约**：

```js
const capture = useSmartCapture({
  enabled,          // 自动拍摄开关
  liveDevice, datasetPath, autoRate,
  board,            // {cols, rows, ...}
  geometry,         // 上面的适配器
  profile,          // FISHEYE_PROFILE | PINHOLE_PROFILE
  mode,             // 'sweep' | 'guided'（见下方模式命名）
  mirror,           // 影响口播左右
  doSnap,           // async () => ({path})，由页面提供（调 api.snap + pushUndo + 刷新列表）
  say, t, setStatus,
});
// → { onMeta, autoHud, counts, guidance, guidedProgress, resetSession, markFromManualSnap }
```

hook 内部持有：`prevCorners` / `lastDetSeq` / `dwellStart` / `maxSharp` / `cellTilts` /
`snapInFlight` / `latestMeta` 等 ref、每格计数 state、引导步骤 ref、转向语音状态机、`autoHud` state。

页面保留：数据集列表、result、undo 栈、全部 UI。

**模式命名**：hook 的词汇是 `'sweep' | 'guided'`。鱼眼页已在 `localStorage`
的 `calib_fisheye_capmode` 里存了历史值 `'polar'`，为不破坏既有用户的偏好，
该键的取值保持 `'polar' | 'guided'`，在传入 hook 时于边界处映射 `'polar' → 'sweep'`。
鱼眼的界面文案键 `fisheye.captureModePolar`（「极坐标」）不变；针孔用新键
`intrinsics.captureModeSweep`（「扫覆盖」），因为针孔的网格不是极坐标。

`FisheyeTab` 的改动为**机械替换**：删除 `onAutoMeta`、`steerVoice`、`guidedSteer`、
`markCellsFromSnap`、`advanceGuidedShot` 及其配套 ref，改为调用 `useSmartCapture(makePolarGeometry(covCircle))`。
逐行核对搬运，不借机改行为。

### 3.4 引导序列的 profile

`GUIDED_STEPS`（17 步、每步 2 张）与 `REGIONS`（center/tl/tr/bl/br/top/bottom/left/right）
描述的是「板在画面里的相对位置」，与相机模型无关，直接复用。阈值抽成 profile：

| 参数 | FISHEYE | PINHOLE | 依据 |
|---|---|---|---|
| `SCALE_NEAR` | 0.54 | 0.75 | 针孔 `scale = 板对角跨度 / min(2rx,2ry) = 跨度/h`，占满画面≈0.9；鱼眼周边压缩，占满也只到 0.55–0.65 |
| `SCALE_FAR` | 0.38 | 0.40 | 同上尺度换算 |
| `TILT_MIN` | 10 | 7 | 针孔视场窄，同样物理倾角产生的透视畸变更小，`boardTiltDeg` 代理读数更低 |
| `TILT_FRONTAL_MAX` | 12 | 10 | 同上，正对判定相应收紧 |
| `ROLL_MIN` | 15 | 15 | 面内旋转与相机模型无关 |
| `ROLL_FRONTAL_MAX` | 12 | 12 | 同上 |
| `ACCEPT_CENTER` | 0.38 | 0.38 | 相对量，无需改 |
| `ACCEPT_OFF` | 0.42 | 0.42 | 同上 |

`PINHOLE_PROFILE` 的四个改动值是**基于几何推算的初值，未经真机验证**，
代码内以注释标注，留待实机调参。鱼眼一列保持现值不变。

### 3.5 `LiveDetectedFrame`

新增 prop `guidedExtent`：

- 传了 → 引导叠加使用它，并且**跳过圆自动检测**（针孔不跑 `detectCircleFromImageData`，
  省掉每 1.2 秒一次的全帧 `getImageData`）。
- 没传 → 维持现有行为（检测圆，`{cx,cy,r}` 转成 `{cx,cy,rx:r,ry:r}` 后走同一条路径）。

引导叠加内部把 `circle.r` 的用处改走 extent：
虚线 FOV 边界由 `arc` 改为 `ellipse(cx, cy, rx, ry)`（鱼眼 `rx===ry` 时即原来的圆）；
`targetHalfSize`（迁至 `guidedSequence.js`）与 `boardScale` 取 `min(rx, ry)`。

针孔的矩形覆盖网格叠加复用组件已有的 `coverageCells` / `coverageCounts` /
`showCoverageGrid` / `showFootprint` / `mirror` —— 这条路径已实现，只是 `IntrinsicsTab` 从未传值。
针孔不传 `fovMask`（无渐晕），也不传 `showPolarGrid`。

## 4. `IntrinsicsTab` 的具体改动

**签名**：`function IntrinsicsTab({ active, tweaks })`（`App.jsx` 已向所有 Tab 传这两个 prop，无需改）。

**覆盖率两阶段**（与鱼眼同构）：
- 解算前 → 用 `useSmartCapture` 的拍摄计数，`percent = 已覆盖格数 / 总格数`。
- 解算后 → 用现成的 `computeCoverage(result.per_frame_residuals, result.image_size)`，
  额外得到每格平均误差用于着色。

**工具栏新增**：模式切换 `Seg`（自由扫覆盖 / 引导序列）、足迹 `Chk`、镜像 `Chk`、
视图 `Seg` 增加 `compare`、右侧读数增加分辨率与 fps。

**实时画面**：传 `coverageCells` / `coverageCounts` / `showCoverageGrid` / `showFootprint` /
`mirror` / `guided` / `guidedExtent`；叠加 HUD 徽章（原因文案 + 停留进度条 + 倾角读数，
引导模式下多一行步骤标签）。

**语音**：`say()` 复用鱼眼的实现与音频片段（中文，`lib/voice.js` 已有全部片段）；
`useVoiceCommands(active === 'intrinsics' && !!tweaks?.voiceCommands, handlers)`，
handler 为 `calibrate` / `photo` / `capture`，含 1200ms 去重。

**存取打磨**：F1–F5 照搬。

**保留针孔专属，不动**：alpha 滑块、`showOrigin` 勾选、8 系数畸变面板（k₁k₂p₁p₂k₃k₄k₅k₆）、
`pinhole-k3/k5/rt` 模型选择、`PX_OK = 0.25 / PX_WARN = 0.5` 阈值。

**默认拍摄模式**：`sweep`（自由扫覆盖），跨会话记在 `localStorage` 的
`calib_intrinsics_capmode` 键下 —— 与鱼眼的 `calib_fisheye_capmode` 相互独立。
镜像同理用 `calib_intrinsics_mirror`。

## 5. i18n

- `fisheye.guided.*`（17 条步骤文案 + 分组名 + 进度模板 + done）几何中立，
  提升到顶层 `guided.*`，两个 Tab 共用；`fisheye.guided.*` 的引用同步改掉。
- 其余约 25 个键补到 `intrinsics.*`（`en.json` 与 `zh.json` 同步）：
  `auto_*`（8 个状态原因）、`autoCapture`、`captureModeSweep`、`captureModeGuided`、
  `footprint`、`mirror`、`coverageGrid`、`viewCompare`、`liveSuffix`、`loadedDetail`、
  `perFrameErrHint`、`noCalibrationYet`、`algo`、`rectifiedRemapFull`、
  `rectifiedUndistortFull`、`voicePlayFailed`。
- `npm run i18n:check`（`build:renderer` 的前置步骤）会卡住任何漏键。

## 6. 验证

仓库现状：`renderer/` **没有任何测试**，只有 `npm run lint` 与 `npm run build:renderer`。
本次第 3.3 节是对已调好功能的重构，需要安全网。

新增 `node --test`（Node 20 内置，零新依赖）覆盖纯函数：

- `lib/boardMetrics.test.js` — `boardTiltDeg` / `boardRollDeg` / `boardScale` 在
  构造的正对 / 倾斜 / 旋转 / 远近角点集上的取值区间。
- `lib/guidedSequence.test.js` — `regionTarget` 落点、`regionOk` 接受半径、
  `poseOk` 在两个 profile 下的分界、`differsEnough` 的四条通路。
- `lib/smartCapture/geometry.test.js` — 两个适配器的 `bin` / `cellAt` / `cellCenter` /
  `pickGuidance` / `radialCue`。
- **回归断言**：以 `{cx, cy, rx: r, ry: r}` 调用泛化后的
  `regionTarget` / `boardScale` / `targetHalfSize`，与重构前的圆版本公式逐点比对，
  断言浮点相等 —— 即 §3.1 的不变式。

接入方式：`package.json` 加 `"test": "node --test renderer/src"`
（Node 20 的 `node --test <目录>` 会递归收集 `*.test.js`，不依赖 shell 的 glob 展开），
`.github/workflows/ci.yml` 的 renderer job 在 build 之前加一步 `npm test`。
测试只 import 纯 `.js` 模块，不碰 JSX，因此无需任何转译或测试环境。

手工验收（无法自动化的部分）：
1. 鱼眼页：扫覆盖模式与引导模式各跑一轮，确认自动拍摄的触发时机、语音、叠加与重构前一致。
2. 针孔页：扫覆盖模式跑一轮，确认覆盖网格随拍摄变绿、HUD 原因文案切换正确、语音引导方向正确（含镜像下左右互换）。
3. 针孔页：引导序列跑完 17 步，确认目标板形、姿态图示、转向箭头、步骤推进正常。
4. 针孔页：compare 视图、镜像、足迹、Load/Save、语音指令逐项点过。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| `FisheyeTab` 重构引入回归 | §3.1 的不变式 + §6 的回归断言 + 逐行核对搬运 + 手工验收第 1 条 |
| `PINHOLE_PROFILE` 四个阈值未经真机验证 | 代码内注释标注为待调初值；扫覆盖模式不依赖这些阈值，引导模式调不准也只影响触发时机，不影响标定正确性 |
| `IntrinsicsTab` 体量增长 | 状态机与几何全在 `lib/` 下，页面只留 UI 与数据集逻辑；预计增至约 750 行，仍低于 `FisheyeTab` 现状 |
