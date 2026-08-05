# 相机参数页（曝光 / 增益 / 白平衡 / 对焦）— 设计

日期：2026-08-04
范围：`backend/app/sources/`、`backend/app/api/routes.py`、`renderer/src/`

## 1. 背景与目标

标定质量直接取决于图像质量：曝光过度会让棋盘格白块糊成一片、欠曝会让黑块吞掉角点、对焦不准会让亚像素角点定位失效。目前这套工具**没有任何调整相机参数的入口** —— 操作员只能靠相机的自动模式，或者去命令行敲 `v4l2-ctl`。

更糟的是，`backend/app/sources/opencv.py` 的 `_open_cap()` 每次打开设备都会强制
`auto_exposure=3`（自动），所以即使在外部调好了手动曝光，一开流就被清掉。

**目标**：新增一个页面，能枚举并调整当前相机的全部 v4l2 控制项，参数按设备持久化、
可存为命名预设，并给出足以判断"调好了没有"的实时反馈。

**非目标**：
- 不支持走厂商 SDK 的工业相机（Basler / FLIR 等不暴露 v4l2 的设备）。
- 不做自动曝光算法（不替驱动做 AE/AWB），只做参数的读写与呈现。
- 不改任何标定算法。

## 2. 硬件与能力现状（实测）

测试机上的 `LRCP imx307_03`（uvcvideo，USB）：

- 暴露 **16 个控制项**：亮度、对比度、饱和度、色调、自动白平衡、伽马、增益、
  电源频率、白平衡色温、锐度、背光补偿、自动曝光、曝光时间、动态帧率、
  对焦绝对值、连续自动对焦。
- **三处联动锁**（`flags=inactive`）：
  | 被锁控制项 | 锁它的父项 |
  |---|---|
  | `exposure_time_absolute` | `auto_exposure`（值 3 = 光圈优先） |
  | `white_balance_temperature` | `white_balance_automatic` |
  | `focus_absolute` | `focus_automatic_continuous` |
- 有稳定的 `Serial: 200901010001`。

## 3. 架构

```
backend/app/sources/
  v4l2_controls.py     新增 — 只负责"和驱动对话"，不知道预设
  control_store.py     新增 — 只负责"存什么"，不碰驱动
  opencv.py            改   — 开流那一刻把两者接起来

backend/app/api/routes.py   新增 4 个路由

renderer/src/
  tabs/CameraParamsTab.jsx        新增 — 页面
  components/ControlWidget.jsx    新增 — 按类型渲染单个控制项
  components/ExposureStats.jsx    新增 — 直方图 / 截断 / 清晰度
  lib/imageStats.js               新增 — 纯函数：直方图、截断率、拉普拉斯方差
```

三个单元的边界是刻意的：驱动对话、持久化、接线各自独立，可以分别理解与测试。

### 3.1 `v4l2_controls.py`

```python
list_controls(device) -> {"supported": bool, "reason": str|None, "controls": [Control]}
set_control(device, name, value) -> {"ok": bool, "error": str|None}
device_serial(device) -> str | None
```

`Control` 的形状：

```python
{ "id": "exposure_time_absolute", "type": "int"|"bool"|"menu",
  "min": 50, "max": 10000, "step": 1, "default": 625, "value": 110,
  "inactive": True, "locked_by": "auto_exposure",
  "group": "camera"|"user",
  "menu": [{"value": 1, "label": "Manual"}, ...] }   # 仅 menu 类型
```

实现走 `v4l2-ctl -d <dev> --list-ctrls-menus` 的文本解析 —— 与仓库既有的
`_force_auto_exposure` 同一路数，不引入新依赖。

**解析器必须是纯函数**：输入是 `v4l2-ctl` 的 stdout 文本，输出是 `Control` 列表。
子进程调用与解析分离，这样解析可以脱离硬件单测。

**`locked_by` 的推断**：v4l2 只告诉我们 `flags=inactive`，不告诉我们是谁锁的。
用一张显式映射表推断，未命中的 `inactive` 控制项 `locked_by` 为 `None`（仍显示为
禁用，只是不给"切到手动"按钮）：

```python
LOCK_PARENTS = {
    "exposure_time_absolute":    ("auto_exposure", 1),              # 1 = Manual
    "exposure_absolute":         ("exposure_auto", 1),              # 老驱动的命名
    "white_balance_temperature": ("white_balance_automatic", 0),
    "focus_absolute":            ("focus_automatic_continuous", 0),
    "focus_auto":                ("focus_automatic_continuous", 0),
    "pan_absolute":              ("pan_auto", 0),
    "tilt_absolute":             ("tilt_auto", 0),
}
```
值是"解锁需要把父项设成什么"。

**非 v4l2 源**：设备路径不匹配 `/dev/video\d+` 时直接返回
`{"supported": False, "reason": "not-a-v4l2-device", "controls": []}`，
不调子进程。ROS2 源走这条路。

### 3.2 `control_store.py`

```python
load() -> dict
active_controls(device) -> dict[str, int] | None     # 当前生效预设的参数
save_preset(device, name, values) -> None
delete_preset(device, name) -> None
set_active(device, name | None) -> None
list_presets(device) -> {"active": str|None, "presets": {name: values}}
```

**存储位置**：`~/.calibration-workbench/camera-controls.json`，与既有的
`~/.calibration-workbench/voice`（见 `backend/app/voice.py:193`）同一个根目录。

**设备键用序列号，不用路径**：`/dev/video0` 会随插拔改变，序列号不会。
`device_serial()` 从 `v4l2-ctl --all` 读 `Serial:`；读不到时回退到设备路径，
并在存储里标注 `"keyed_by": "path"`，这样以后诊断时知道这条记录不可靠。

```json
{ "version": 1,
  "devices": {
    "200901010001": {
      "keyed_by": "serial",
      "active": "室内",
      "presets": {
        "室内": {"auto_exposure": 1, "exposure_time_absolute": 300, "gain": 64},
        "强光": {"auto_exposure": 1, "exposure_time_absolute": 80,  "gain": 32}
      } } } }
```

**预设挂在设备下，不跨设备共享。** 不同相机的控制项集合不同，跨设备套用会有一半
参数落空且无从提示。

**写入原子性**：写临时文件后 `os.replace`，避免进程在写一半时被杀导致配置损坏。

### 3.3 与开流的协调 —— 本设计的关键冲突点

`opencv.py:_open_cap()` 现在无条件调用 `_force_auto_exposure(device)`，注释说明
这是为了防 IMX307 这类相机锁死在手动曝光 + 极短曝光时间上导致全黑画面。

**这会清掉用户设的任何手动曝光**，而且是静默的：流一重启（切分辨率、页面切换导致
引用计数归零、后端重连）参数就没了，画面只是突然变亮，不报错。

改为：

```python
saved = control_store.active_controls(self.device)
if saved:
    apply_controls(self.device, saved)   # 回放用户意图
else:
    _force_auto_exposure(self.device)    # 保留原有防黑屏保护
```

用户没设过 → 与今天行为完全一致；设过 → 尊重用户。防黑屏保护没有丢失，
只是不再无条件覆盖用户的显式选择。

顺序上仍在 `cv2.VideoCapture` 之前 —— 与既有注释的理由相同（驱动只在开流前接受
`auto_exposure` 的改变）。

**应用顺序**：父项先于子项。`exposure_time_absolute` 在 `auto_exposure=1` 之前设会被
驱动忽略。`apply_controls` 按 `LOCK_PARENTS` 做一次拓扑排序，父项排在前面。

### 3.4 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/camera/controls?device=` | 枚举控制项（含 inactive / locked_by） |
| POST | `/camera/control` | `{device, name, value}` 设单项，返回刷新后的全量列表 |
| GET | `/camera/presets?device=` | 列出该设备的预设与当前生效项 |
| POST | `/camera/presets` | `{device, action: save\|delete\|activate\|reset, name?, values?}` |

`POST /camera/control` **返回刷新后的全量控制项列表**，不只是成功标志 ——
因为改一个控制项可能解锁/锁住另一个，解锁关系由驱动决定，不该在前端猜。

`action: reset` 把该设备的参数全部设回驱动报告的 `default`，并清除 `active`。

### 3.5 前端

新页面 `CameraParamsTab.jsx`，注册为 Tab 05：

- **左栏**：相机源选择（复用 `CameraSourcePanel`）；预设管理（新建 / 切换 / 删除 /
  恢复默认）；不支持的源在此处显示原因。
- **中间**：实时预览（复用 `LivePreview`，已是 canvas + WebSocket）+ 曝光反馈条。
- **右栏**：控制项列表。`曝光 / 增益 / 白平衡 / 对焦` 四组置顶，其余按 v4l2 的
  User / Camera 分组折叠。

**`ControlWidget.jsx`** 按 `type` 渲染：`int` → 滑块 + 数字框；`bool` → 勾选；
`menu` → 下拉。`inactive` 时整体禁用并显示"被 `<locked_by>` 锁定"，旁边给
「切到手动」按钮（点击后先设父项再解锁）。

**`imageStats.js`（纯函数，可单测）**：

```js
histogram(rgba, w, h) -> Uint32Array(256)        // 亮度直方图
clipping(hist, total) -> {high: number, low: number}   // 截断比例 0..1
laplacianVar(gray, w, h) -> number               // 清晰度
downsample(rgba, w, h, tw, th) -> {data, w, h}   // 最近邻降采样
```

**`ExposureStats.jsx`** 每 6 帧取一次画布（`getImageData`），先降采样到 160×120
再算 —— 全分辨率逐帧计算会拖垮渲染进程。显示：

- 亮度直方图（256 桶）
- **高光截断 % / 暗部截断 %** —— 比让人看直方图直观
- **清晰度**读数 + 近 5 秒趋势条（调对焦时看峰值）

反馈全部在前端从既有的预览画布算，**不新增后端负担，也不需要开检测流**。

### 3.6 跨页面影响

参数是设备级的，一旦生效，其他四个标定页拿到的都是调整后的画面 —— 这是期望行为
（调好曝光就是为了让标定拍得更好）。不需要额外的状态指示：画面本身就是反馈。

唯一需要注意的是：**改参数不重启流**。所有 `v4l2-ctl -c` 的写入对正在运行的流即时
生效，不触碰 `VideoCapture`。

## 4. 验证

**pytest（`backend/tests/`）**
- `test_v4l2_parse.py`：用测试机真实 `--list-ctrls-menus` 输出做夹具，断言 16 个
  控制项的类型、范围、默认值、`inactive` 标志；另加边界样本 —— 空输出、
  没有 min/max 的控制项、菜单缺项、含中文/特殊字符的标签。
- `test_control_store.py`：预设增删改查、`active` 切换、序列号回退到路径、
  原子写入（写一半被中断后旧文件仍可读）、版本字段缺失时的兼容。
- `test_apply_order.py`：`apply_controls` 的父项先于子项排序。

**node --test（`renderer/src/lib/imageStats.test.js`）**
- `histogram`：全黑 → 桶 0 为全部像素；全白 → 桶 255；渐变 → 均匀分布。
- `clipping`：构造 10% 纯白 + 10% 纯黑的图，断言 high≈0.1、low≈0.1。
- `laplacianVar`：纯色图方差为 0；棋盘格图方差显著大于模糊后的同图。
- `downsample`：尺寸正确、角点像素取值正确。

**手工验收**（需真机）
1. 设手动曝光 → 切分辨率 → 参数仍在（验证 §3.3 的回放）。
2. 删掉全部预设 → 开流仍强制自动、不黑屏（验证防黑屏保护未丢）。
3. 拖 `exposure_time_absolute` 在 `auto_exposure=3` 时被禁用；点「切到手动」后可调。
4. 遮住镜头 → 暗部截断% 上升；对着灯 → 高光截断% 上升。
5. 转对焦环 → 清晰度读数出现明显峰值。
6. 切到 ROS2 源 → 显示"由 ROS2 驱动节点管理"，不出现空面板。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| `v4l2-ctl` 输出格式随版本变化 | 解析器容错：无法解析的行跳过而非抛异常；夹具测试锁住已知格式 |
| 某些控制项写入被驱动拒绝 | `set_control` 返回 `ok: false` + 驱动的 stderr，前端就地显示，不静默失败 |
| 预设里的控制项在换相机后不存在 | 应用时逐项尝试，不存在的跳过并记录；不因一项失败中断其余 |
| `getImageData` 在部分 GPU 合成路径上较慢 | 降采样到 160×120 + 每 6 帧一次；若仍卡，降到每 12 帧 |
