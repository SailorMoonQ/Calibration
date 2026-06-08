# Critical 问题修复总结
**日期**: 2026-06-08  
**修复版本**: v2 (完整修复)

## 修复的问题

### 🔴 Critical 级别（3 个）

#### 1. Polar 模式锁机制缺陷
**问题**: Polar 模式的 `snapInFlightRef.current = true` 在 ready gate 检查**之后**设置（line 659），导致两帧可能同时通过 ready 检查并触发双重 snap。

**修复**:
```javascript
// 之前：锁检查在 ready 条件中
const ready = novel && sharpOk && still && debounced && !snapInFlightRef.current;

// 之后：分离锁检查，在 dwell 完成后原子性地设置锁
const ready = novel && sharpOk && still && debounced;
if (!ready || snapInFlightRef.current) {
  // early return
}
// ... dwell logic ...
if (held < DWELL_MS) return;

// Atomically claim the lock before starting async work
if (snapInFlightRef.current) return;  // double-check after dwell
snapInFlightRef.current = true;
```

**效果**: 防止 dwell 完成到锁设置之间的竞态窗口。

---

#### 2. Guided 模式组件卸载后状态更新
**问题**: Guided 模式的异步 snap 回调在 `await` 之后调用 `setStatus`, `setGuidedProgress`, `setSelected`，但没有检查组件是否已卸载。用户切换标签时会触发 React 警告。

**修复**:
```javascript
// 添加卸载守卫 ref
const snapCancelledRef = useRef(false);
useEffect(() => {
  snapCancelledRef.current = false;
  return () => { snapCancelledRef.current = true; };
}, []);

// 在异步回调中检查
const r = await api.snap(liveDevice, datasetPath);
if (snapCancelledRef.current) return;  // component unmounted
// ... 状态更新 ...
const files = await refreshDataset();
if (snapCancelledRef.current) return;  // check again after async
```

**效果**: 组件卸载后不再执行状态更新，消除 React 警告和潜在的状态破坏。

---

#### 3. Polar 模式组件卸载后状态更新
**问题**: 与 Guided 模式相同，Polar 模式的异步回调也缺少卸载守卫。

**修复**: 使用相同的 `snapCancelledRef` 守卫机制。

---

### 🟠 High 级别（修复了 3 个关键问题）

#### 4. Manual Snap 锁检查不完整
**问题**: `onSnap` 仅在 guided 模式检查锁，polar 模式下手动 snap 可以与 auto-capture 竞争。

**修复**:
```javascript
// 之前：仅 guided 模式检查
const guided = captureModeRef.current === 'guided';
if (guided && snapInFlightRef.current) return;

// 之后：无条件检查锁
if (snapInFlightRef.current) return;  // at the very beginning
// ... 
const guided = captureModeRef.current === 'guided';
```

**效果**: 所有手动 snap 都被 auto-capture 锁阻止，消除 polar 模式的竞争。

---

#### 5. Manual Snap 锁使用不一致
**问题**: Guided 模式的手动 snap 设置锁，但 polar 模式不设置，导致快速按空格键时 polar 模式可能双重 snap。

**修复**:
```javascript
// 之前：仅 guided 模式设置锁
if (guided) snapInFlightRef.current = true;
// ...
finally {
  if (guided) snapInFlightRef.current = false;
}

// 之后：无条件设置和清理锁
try {
  snapInFlightRef.current = true;  // always set
  // ... snap logic ...
} finally {
  snapInFlightRef.current = false;  // always clear
}
```

**效果**: Guided 和 polar 模式使用统一的锁机制，防止所有手动 snap 竞争。

---

#### 6. 锁设置和 Ready Check 的原子性
**问题**: 两种模式的锁都在 ready 条件检查**之后**设置，存在竞态窗口。

**修复**: 在两种模式中都实现了：
1. 将锁检查从 ready 条件中分离
2. 在 dwell 完成后、启动异步工作前进行 double-check
3. 原子性地设置锁

```javascript
// Guided 模式
const readyG = rOk && pOk && !needVary && sharpOk && still && debouncedG;
if (!readyG || snapInFlightRef.current) {  // separate lock check
  // early return
}
// ... dwell ...
if (heldG < DWELL_MS) return;

// Atomically claim the lock before starting async work
if (snapInFlightRef.current) return;  // double-check after dwell
snapInFlightRef.current = true;

// Polar 模式同样处理
```

**效果**: 消除 ready check 到锁设置之间的竞态窗口。

---

## 修复后的架构

### 锁机制（snapInFlightRef）
```
Auto-capture (guided):  ready check → dwell → double-check → SET LOCK → snap → CLEAR LOCK
Auto-capture (polar):   ready check → dwell → double-check → SET LOCK → snap → CLEAR LOCK
Manual snap:            CHECK LOCK (early return if locked) → SET LOCK → snap → CLEAR LOCK
```

**关键改进**:
- ✅ 锁的检查和设置现在是原子性的（double-check 模式）
- ✅ 所有 snap 路径（auto guided, auto polar, manual）都使用统一的锁
- ✅ Manual snap 无条件检查和设置锁，不区分模式

### 组件卸载守卫（snapCancelledRef）
```
Component mount:   snapCancelledRef = false
Async operation:   await api.snap() → CHECK → await refreshDataset() → CHECK
Component unmount: snapCancelledRef = true (cleanup)
```

**检查点**:
- ✅ 每次 `await` 之后立即检查
- ✅ 所有状态更新之前检查
- ✅ catch 块中也检查（避免显示错误给已卸载的组件）

---

## 文件改动

**文件**: `renderer/src/tabs/FisheyeTab.jsx`

**改动统计**:
- 新增 6 行（snapCancelledRef 守卫）
- 修改约 50 行（锁逻辑重构）
- 删除 0 行

**关键改动位置**:
1. Line ~456: 添加 `snapCancelledRef` 和 cleanup effect
2. Line ~545-590: Guided 模式 auto-capture 重构
3. Line ~650-685: Polar 模式 auto-capture 重构
4. Line ~787-820: Manual snap (`onSnap`) 重构

---

## 验证

### Lint 检查
```bash
npm run lint
```
**结果**: ✅ 0 errors, 48 warnings（警告为已存在问题）

### 预期行为

#### Guided 模式
1. **Auto-capture 正常**: dwell → snap → 步骤推进 ✓
2. **Manual snap 被阻止**: auto-capture 进行中按空格 → 静默忽略 ✓
3. **Manual snap 工作**: auto-capture 完成后按空格 → snap 并推进 ✓
4. **组件卸载安全**: snap 进行中切换标签 → 不会触发 React 警告 ✓

#### Polar 模式
1. **Auto-capture 正常**: dwell → snap → 计数更新 ✓
2. **Manual snap 被阻止**: auto-capture 进行中按空格 → 静默忽略 ✓
3. **Manual snap 工作**: auto-capture 完成后按空格 → snap 并计数 ✓
4. **组件卸载安全**: snap 进行中切换标签 → 不会触发 React 警告 ✓
5. **双重按键防护**: 快速按空格两次 → 只触发一次 snap ✓

#### 跨模式
1. **锁统一**: Guided auto-capture 锁住时，polar manual snap 被阻止 ✓
2. **锁统一**: Polar auto-capture 锁住时，guided manual snap 被阻止 ✓

---

## 仍然存在的问题

### High 级别（2 个）

1. **polarCounts 异步状态冲突** (`FisheyeTab.jsx:666`)
   - `markCellsFromSnap()` 读取的 `latestMetaRef` 可能是 500ms 前的旧数据
   - 需要在 snap 时捕获 meta 而不是从共享 ref 读取

2. **LiveDetectedFrame WebSocket 竞争** (`LiveDetectedFrame.jsx:636-685`)
   - WebSocket 创建时不检查 `cancelled`
   - 需要在 WebSocket URL resolve 后检查 cancelled

### Medium 级别（17 个）
主要是非关键的竞态条件、空值检查、内存泄漏等，可在后续迭代修复。

---

## 提交建议

```bash
git add renderer/src/tabs/FisheyeTab.jsx
git commit -m "fix(fisheye): comprehensive race condition fixes for snap operations

修复 auto-capture 和 manual snap 的多个严重竞态条件问题。

## Critical Fixes
- Polar 模式锁在 dwell 完成后原子性设置，消除竞态窗口
- 添加组件卸载守卫（snapCancelledRef），防止卸载后状态更新
- Manual snap 无条件检查锁，统一 guided 和 polar 行为

## High Priority Fixes
- Manual snap 现在对所有模式设置锁，防止快速按键双重 snap
- 所有 snap 路径（auto guided, auto polar, manual）使用统一锁机制
- 锁的检查和设置现在是原子性的（double-check 模式）

## Technical Details
- snapInFlightRef: 统一的 snap 锁，所有路径共享
- snapCancelledRef: 组件卸载守卫，在每个 await 后检查
- 锁设置从 ready check 中分离，在 dwell 完成后原子性声明

这些修复消除了之前审计发现的 3 个 Critical 和 3 个 High 级别问题。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 后续建议

### 短期（建议在合并前完成）
1. 修复 `polarCounts` 异步状态冲突（High）
2. 添加 WebSocket 的 cancelled 检查（High）
3. 手动测试所有修复的场景

### 中期（下一个迭代）
1. 为 snap 流程添加单元测试
2. 重构为状态机模式（更清晰的状态转换）
3. 修复 Medium 级别的内存泄漏和空值检查

### 长期
1. 考虑使用 React Query 或 SWR 管理异步状态
2. 统一所有异步操作的取消模式
3. 添加 E2E 测试覆盖并发场景
