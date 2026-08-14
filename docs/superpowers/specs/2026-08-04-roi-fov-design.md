# 相机中心点与视野对齐页（ROI / FOV）— 设计

日期：2026-08-04
范围：`backend/app/sources/opencv.py`、`backend/app/api/routes.py`、`renderer/src/`
前置：`2026-08-04-camera-params-design.md`（相机参数页）先行落地

## 1. 背景与目标

镜头模组的光轴很少正好落在传感器几何中心上：装配公差、镜头座偏移、模组批次差异都会
让主点 `(cx, cy)` 偏离画面中心几十甚至上百像素。后果是画面"看起来正"，但畸变中心
不在中心，去畸变后边缘不对称，多相机拼接时也对不齐。

**目标**：新增一个页面，做两件事——

1. **诊断**：拿已标定的 `K` 算出主点偏移量与实际视场角，明确告诉操作员"这颗镜头偏了
   多少像素、往哪个方向"。对所有图像源可用。
2. **对齐**：计算并应用一个 ROI（感兴趣区域）裁剪窗口，使光轴落在输出画面正中心。

**流程定位**：裁剪是**标定前的一次性设置**。

```
粗标一次 → 拿到 cx,cy → 定 ROI → 应用 → 重标一次 → 最终 K
```

不存在新旧 `K` 混用：ROI 定好之后，后续所有拍摄与标定都基于裁剪后的流。

## 2. 硬件现实（实测）

测试机上的 `LRCP imx307_03`（uvcvideo）：

```
VIDIOC_G_SELECTION target=crop         失败：Invalid argument
VIDIOC_G_SELECTION target=native_size  失败
VIDIOC_G_SELECTION target=compose      失败
无 ROI / zoom / pan / tilt 控制项，无厂商扩展单元（XU）
```

**UVC 规范本身没有标准裁剪控制**，绝大多数 USB 相机都如此。部分 MIPI/CSI 的 v4l2
驱动（Jetson、树莓派等）确实支持 `VIDIOC_S_SELECTION`。

**决策：v1 只实现软件裁剪，但实现并展示硬件能力探测。**

理由：手头唯一可测的设备不支持硬件裁剪，写一条无法验证的硬件路径，风险大于收益——
它会以"看起来支持"的姿态存在，直到某天在真机上以未知方式失败。页面会明确显示
`此相机不支持硬件裁剪，将使用软件裁剪（损失分辨率）`，探测结果如实呈现。等有支持
硬件裁剪的设备时再补，届时能真验证。

## 3. 与既有 clip 机制的协调 —— 本设计的关键点

`backend/app/sources/opencv.py` 已有 `_maybe_clip()`：当帧的任一边超过
`_clip_target`（默认 `(720, 720)`）时，**居中裁剪到目标宽高比再缩放到目标尺寸**。

两个特性使它不能直接用于 ROI 对齐：

- **只能居中**，无法偏移 —— 而对齐光轴恰恰需要偏移。
- **会缩放** —— 缩放改变 `fx, fy`，让 `K` 的推导多一层耦合。

**ROI 定义在"消费者今天看到的帧"的坐标系里**，即 `_maybe_clip` 之后：

```
原始帧 → _maybe_clip（既有，居中裁+缩放）→ ROI 裁剪（新增，可偏移，不缩放）→ 消费者
```

这样选的理由是它让推导变得平凡：用户在当前流上标定得到的 `cx, cy` 就直接是 ROI 的
输入，不需要任何坐标换算；ROI 不缩放，所以 `fx, fy` 不变；裁剪后的新主点就是

```
cx' = cx - left        cy' = cy - top
```

畸变系数在径向模型下不受平移影响，保持不变。

这个推导足够简单，可以直接呈现给用户看（页面会显示"应用后 K 将变为…"），
而不是让他们相信一个黑盒。

## 4. 架构

```
backend/app/sources/
  opencv.py        改 — 新增 set_roi() / _maybe_roi()，在 _maybe_clip 之后执行
  roi_store.py     新增 — 每设备 ROI 的持久化（与 control_store 同一目录、同一模式）
  v4l2_controls.py 改 — 新增 supports_hw_crop(device) 能力探测

backend/app/api/routes.py   新增 3 个路由

renderer/src/
  tabs/RoiFovTab.jsx        新增 — 页面
  lib/opticalCenter.js      新增 — 纯函数：偏移量、FOV、ROI 求解、K 变换
  lib/opticalCenter.test.js 新增
```

### 4.1 `opticalCenter.js`（纯函数，全部可单测）

```js
// 主点相对画面中心的偏移（像素，右/下为正）
centerOffset(K, size) -> {dx, dy, distance}

// 由 fx, fy 与画幅算实际视场角（度）
fieldOfView(K, size) -> {horizontal, vertical, diagonal}

// 以 (cx,cy) 为中心、能取到的最大 ROI；不放大、不越界
maxCenteredRoi(K, size) -> {left, top, width, height}

// 按用户指定的宽高求 ROI（仍以光轴为中心），超界则钳制并标记
roiFor(K, size, wantW, wantH) -> {left, top, width, height, clamped}

// 应用 ROI 后的 K
kAfterRoi(K, roi) -> K'
```

`maxCenteredRoi` 的推导：要让光轴落在输出中心，ROI 必须以 `(cx, cy)` 为中心。
在不越界前提下最大的这种窗口是

```
width  = 2 * min(cx, W - cx)
height = 2 * min(cy, H - cy)
```

**偏移越大，可用画幅损失越大** —— 这个代价必须在界面上显式呈现（见 §4.3），
因为它是操作员决定"是拧硬件还是接受裁剪"的依据。

### 4.2 后端

`CameraSource.set_roi(left, top, width, height)`：`None` 或全零表示关闭。
`_maybe_roi()` 在 `_maybe_clip()` 之后、写入 `_latest` 之前执行，纯切片、不缩放、
不重启相机 —— 与 `set_clip` 同样是下一帧即生效。

越界的 ROI 被钳制到帧内并记录警告，而不是抛异常导致整条流中断。

`roi_store.py` 与 `control_store.py` 同构：`~/.calibration-workbench/camera-roi.json`，
按序列号键控，原子写入。开流时回放。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/camera/roi?device=` | 当前 ROI + 硬件裁剪能力 + 源尺寸 |
| POST | `/camera/roi` | `{device, left, top, width, height}` 或 `{device, clear: true}` |
| GET | `/camera/hw_crop?device=` | 单独的能力探测（供页面显示） |

### 4.3 页面

- **左栏**：相机源；加载标定文件（复用既有的 `pickOpenFile` + `api.loadCalibration`）；
  硬件裁剪能力显示；ROI 的启用/清除与持久化状态。
- **中间**：实时预览，叠加——
  - **画面几何中心**：细十字（灰）
  - **光学主点**：实心靶标（琥珀），两者之间画一条带箭头的连线
  - **拟应用的 ROI 框**：虚线矩形，框外区域压暗
- **右栏**：读数
  - 主点偏移 `dx, dy` 像素 + 占画幅百分比
  - 当前 FOV（水平/垂直/对角，度）
  - 应用 ROI 后的 FOV 与**画幅损失百分比**
  - 应用后的 `K'`（明确列出 `cx', cy'`，`fx, fy` 标注"不变"）

未加载标定文件时，页面只显示画面中心十字，并提示"先在 01/02 页标定一次并保存，
再回到这里"——而不是拿一个猜测的主点画一个假的靶标。

## 5. 验证

**node --test（`renderer/src/lib/opticalCenter.test.js`）**
- `centerOffset`：主点正好在中心 → `{0,0,0}`；偏右下 → `dx,dy` 为正且 `distance` 正确。
- `fieldOfView`：对已知 `fx` 与画幅手算校验（`2·atan(w/(2·fx))`）；正方形画幅时
  水平=垂直；对角大于两者。
- `maxCenteredRoi`：主点居中 → ROI 等于全画幅；主点偏右 → 宽度按 `2·(W-cx)` 收缩；
  主点在边缘 → 宽度趋近 0 但不为负。
- `kAfterRoi`：`fx, fy` 不变；`cx', cy'` 等于原值减去 `left, top`；应用
  `maxCenteredRoi` 的结果后，新主点恰好落在新画幅中心（这条是整个功能的正确性核心）。
- `roiFor`：请求超过可用尺寸时钳制并置 `clamped`。

**pytest（`backend/tests/test_roi.py`）**
- `_maybe_roi` 的切片正确性、越界钳制、关闭时透传。
- ROI 与 `_maybe_clip` 的组合顺序：构造超过 clip 阈值的帧，断言先居中缩放再 ROI。
- `roi_store` 的读写与序列号回退（与 control_store 同构，复用测试模式）。

**手工验收**（需真机）
1. 加载一份标定 → 靶标位置与读数合理（偏移量与 `cx-W/2` 一致）。
2. 应用 ROI → 预览立即变为裁剪后画面，无需重启流。
3. 重启应用 → ROI 仍在。
4. 清除 ROI → 恢复全画幅。
5. 裁剪后在 01 页重标 → 得到的 `cx, cy` 应接近新画幅中心（这是端到端的正确性验证）。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 用户在 ROI 生效后忘记重标，用旧 K 去畸变 | 页面显式显示"应用后需重新标定"；ROI 生效时在预览角落常驻标记 |
| 主点偏移很大导致可用画幅过小 | 界面直接给出画幅损失百分比，让用户能判断该拧硬件而非裁剪 |
| 标定本身不准导致主点估计错误 | 页面显示所加载标定的 rms；rms 过大时给出提醒 |
| ROI 与 clip 的组合让人搞不清最终画幅 | 右栏列出完整变换链：源尺寸 → clip 后 → ROI 后 |
