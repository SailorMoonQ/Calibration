import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Section, Seg, Chk, Field, Matrix } from '../components/primitives.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { RectifiedFrame } from '../components/RectifiedFrame.jsx';
import { RectifiedLivePreview } from '../components/RectifiedLivePreview.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { LiveDetectedFrame } from '../components/LiveDetectedFrame.jsx';
import { useCameraSource, CameraSourcePanel } from '../components/CameraSource.jsx';
import {
  FrameStrip, ErrorPanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
  trafficKindForRms, trafficColor,
} from '../components/panels.jsx';
import { totalPolarCells, polarCellAt, RINGS, SECTORS } from '../lib/polarCoverage.js';
import { GUIDED_STEPS, FISHEYE_PROFILE } from '../lib/guidedSequence.js';
import { makePolarGeometry } from '../lib/smartCapture/geometry.js';
import { useSmartCapture } from '../lib/smartCapture/useSmartCapture.js';
import { speak } from '../lib/voice.js';
import { useVoiceCommands } from '../lib/voiceControl.js';
import { DEFAULT_CHESS_BOARD } from '../lib/board.js';
import { confirm } from '../components/confirm.jsx';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

const ZERO_K = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]];

// Camera mount inferred from a ROS2 image source like
// "ros2:/camera/head/color/image_rect_compressed" → "head". When present, saving
// writes straight into the robot's shared camera_intrix.yaml under that mount.
const CAMERA_SLOT_RE = /\/camera\/(head|left|right|back)\//;
function cameraSlotFromSource(...sources) {
  for (const s of sources) {
    const m = CAMERA_SLOT_RE.exec(s || '');
    if (m) return m[1];
  }
  return null;
}

export function FisheyeTab({ active, tweaks }) {
  const { t } = useTranslation();
  const [board, setBoard] = useState(DEFAULT_CHESS_BOARD);
  const [model, setModel] = useState('equidistant');
  const [view, setView] = useState('split');
  const [showBoard, setShowBoard] = useState(true);
  const [showResid, setShowResid] = useState(true);
  const [balance, setBalance] = useState(0.6);
  const [fovScale, setFovScale] = useState(1.0);
  const [method, setMethod] = useState('remap'); // 'remap' | 'undistort'
  const [liveDetect, setLiveDetect] = useState(false);
  const [autoCapture, setAutoCapture] = useState(false);
  const [autoRate, setAutoRate] = useState(0.5);  // seconds between auto-snaps
  // 二选一的自动检测/叠加模式：'polar' 极坐标覆盖靶盘（手持扫覆盖），
  // 'guided' 文档引导序列（按手册清单逐个位置/动作各拍两张）。跨会话记住。
  const [captureMode, setCaptureMode] = useState(() => localStorage.getItem('calib_fisheye_capmode') || 'polar');
  const showPolar = captureMode === 'polar';
  const guidedMode = captureMode === 'guided';
  const [showFootprint, setShowFootprint] = useState(false); // 检测可达足迹热力
  // 镜像翻转：仅用于实时预览画面，不影响抓拍帧/校正视图/保存的原图。勾选状态跨会话记住。
  const [mirror, setMirror] = useState(() => localStorage.getItem('calib_fisheye_mirror') === '1');

  // Auto-detected fisheye image circle {cx,cy,r}, reported by LiveDetectedFrame.
  // Drives the polar dartboard, capture binning, and the FOV boundary.
  const [circle, setCircle] = useState(null);

  // When onLoad sets datasetPath from a loaded calibration, the dataset-listing effect
  // would normally clear the just-loaded result. This ref tells the effect "skip the
  // result reset on the next listing — the result is fresh, not stale."
  const skipResultResetRef = useRef(false);

  const [datasetPath, setDatasetPath] = useState('');
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // status carries a message plus an explicit error flag, so the solver-status
  // color is language-independent (no regex-matching the localized text).
  const [status, setStatusMsg] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const setStatus = (msg, isErr = false) => { setStatusMsg(msg); setStatusErr(isErr); };

  const [viewMode, setViewMode] = useState('live'); // 'live' | 'frame'

  const cam = useCameraSource({
    pollEnabled: viewMode === 'live' || datasetFiles.length === 0,
  });
  const { liveDevice, streamInfo } = cam;

  const errByPath = useMemo(() => {
    if (!result?.ok) return null;
    const m = new Map();
    (result.detected_paths || []).forEach((p, i) => m.set(p, result.per_frame_err?.[i] ?? 0));
    return m;
  }, [result]);
  const residualsByPath = useMemo(() => {
    if (!result?.ok) return null;
    const m = new Map();
    (result.detected_paths || []).forEach((p, i) => m.set(p, result.per_frame_residuals?.[i]));
    return m;
  }, [result]);

  const imgSizeForCov = result?.image_size
    || (streamInfo?.open ? [streamInfo.width, streamInfo.height] : null);

  // The circle the polar grid is binned against. Prefer the auto-detected one;
  // fall back to a centred geometric circle (radius ≈ the image half-height,
  // matching the inscribed fisheye disk) until detection lands.
  const covCircle = useMemo(() => {
    if (circle) return circle;
    if (!imgSizeForCov) return null;
    const [w, h] = imgSizeForCov;
    if (!w || !h) return null;
    // 0.98 (not >1): keep the outer ring just inside the inscribed fisheye disk.
    // Overshooting pushes the outermost cells into the black border, where no real
    // corner can ever land, so coverage could never reach 100%. Used only until
    // detectCircleFromImageData lands a measured circle.
    return { cx: w / 2, cy: h / 2, r: (Math.min(w, h) / 2) * 0.98 };
  }, [circle, imgSizeForCov?.[0], imgSizeForCov?.[1]]);

  // The capture geometry: the polar dartboard laid over the detected image circle.
  // Re-made whenever the circle moves so the state machine bins against the truth.
  const geometry = useMemo(() => makePolarGeometry(covCircle), [covCircle]);

  const frames = useMemo(() => datasetFiles.map((p, i) => ({
    id: i + 1, err: errByPath?.get(p) ?? 0, tx: 0, ty: 0, rot: 0,
  })), [datasetFiles, errByPath]);

  const [selected, setSelected] = useState(1);

  useEffect(() => {
    if (!datasetPath) return;
    let cancelled = false;
    api.listDataset(datasetPath).then(r => {
      if (cancelled) return;
      setDatasetFiles(r.files);
      setStatus(t('common.imagesInDataset', { count: r.count }));
      setSelected(1);
      if (skipResultResetRef.current) {
        // onLoad just brought a fresh calibration in tandem with this dataset path;
        // don't wipe it.
        skipResultResetRef.current = false;
      } else {
        setResult(null);
      }
    }).catch(e => !cancelled && setStatus(t('common.listingFailed', { error: e.message }), true));
    return () => { cancelled = true; };
  }, [datasetPath]);

  const boardPayload = () => ({
    type: board.type,
    cols: board.cols,
    rows: board.rows,
    square: board.sq,
    marker: board.marker ?? null,
    dictionary: 'DICT_5X5_100',
  });

  const onPickFolder = async () => {
    const p = await pickFolder(datasetPath || undefined);
    if (p) setDatasetPath(p);
  };

  const refreshDataset = async () => {
    if (!datasetPath) return;
    const r = await api.listDataset(datasetPath);
    setDatasetFiles(r.files);
    return r.files;
  };

  // Soft-delete every image in the folder to .trash/ (keeps the folder path).
  // Undoable as a single ⌘Z that restores them all.
  const onClear = async () => {
    if (!datasetPath || datasetFiles.length === 0) { setStatus(t('common.noImagesToRemove')); return; }
    const ok = await confirm({
      message: t('common.confirmClear', { count: datasetFiles.length }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    try {
      const r = await api.clearDataset(datasetPath);
      if (r.moved?.length) {
        pushUndo({ kind: 'clear', entries: r.moved.map(m => ({ path: m.path, trashPath: m.trash_path })) });
      }
      await refreshDataset();
      setSelected(1);
      setResult(null);
      setViewMode('live');
      setStatus(t('common.removedImages', { count: r.count }));
    } catch (e) { setStatus(t('common.clearFailed', { error: e.message }), true); }
  };

  // Refs that the global keydown handler reads from so it always sees the freshest
  // closures without re-attaching the listener on every render.
  const onSnapRef = useRef(null);
  const onUndoRef = useRef(null);
  const onDropRef = useRef(null);
  const onRunRef = useRef(null);
  const lastVoiceCommandRef = useRef({ command: '', ts: 0 });
  const datasetCountRef = useRef(0);
  useEffect(() => { datasetCountRef.current = datasetFiles.length; }, [datasetFiles.length]);

  const acceptVoiceCommand = useCallback((command) => {
    const now = performance.now();
    const last = lastVoiceCommandRef.current;
    if (last.command === command && now - last.ts < 1200) return false;
    lastVoiceCommandRef.current = { command, ts: now };
    return true;
  }, []);

  const voiceHandlers = useMemo(() => ({
    calibrate: () => {
      if (!acceptVoiceCommand('calibrate')) return;
      onRunRef.current?.();
    },
    photo: () => {
      if (!acceptVoiceCommand('snap')) return;
      onSnapRef.current?.();
    },
    capture: () => {
      if (!acceptVoiceCommand('snap')) return;
      onSnapRef.current?.();
    },
  }), [acceptVoiceCommand, t]);

  useVoiceCommands(active === 'fisheye' && !!tweaks?.voiceCommands, voiceHandlers);

  // Undo stack: bounded LIFO of {kind: 'snap'|'drop', path, trashPath?}.
  // - snap: undo deletes (trashes) the just-snapped file
  // - drop: undo restores from .trash/ back to original path
  const UNDO_LIMIT = 20;
  const undoStackRef = useRef([]);
  const pushUndo = (entry) => {
    const stack = undoStackRef.current;
    stack.push(entry);
    if (stack.length > UNDO_LIMIT) stack.shift();
  };

  useEffect(() => { localStorage.setItem('calib_fisheye_capmode', captureMode); }, [captureMode]);

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
      // AbortError ("play() interrupted by a new load request") is EXPECTED: a newer
      // cue intentionally cut this one off (one shared <audio>, prompts don't stack).
      // That's not a failure — swallow it. Only surface genuine blocks (autoplay
      // NotAllowedError, missing codec/device, …), de-duped so a persistent block
      // doesn't overwrite the status bar on every cue.
      if (e?.name === 'AbortError') return;
      const msg = e?.message || e?.name || 'play blocked';
      if (msg === voiceErrRef.current) return;
      voiceErrRef.current = msg;
      setStatus(t('fisheye.voicePlayFailed', { name, error: msg }), true);
    });
  }, [voicePrompts, t]);

  // Mirror flip only affects the live preview picture, so this effect keeps just
  // the localStorage persistence — the smart-capture hook owns mirror for the
  // spoken-direction swap (passed in below as a prop).
  useEffect(() => { localStorage.setItem('calib_fisheye_mirror', mirror ? '1' : '0'); }, [mirror]);

  // Capture-only: save the frame and make it undoable. Resolves as soon as the
  // path is known — deliberately does NOT touch the dataset listing, so the
  // hook can tally coverage against the pose that was actually captured
  // (against the freshest `latestMetaRef`) before an `api.listDataset`
  // round-trip gives the live stream time to move the board off that pose.
  const snapOnce = useCallback(async () => {
    const r = await api.snap(liveDevice, datasetPath);
    pushUndo({ kind: 'snap', path: r.path });
    return r;
  }, [liveDevice, datasetPath]);

  // Runs AFTER the hook has already tallied coverage, advanced the guided
  // step, spoken the cue, and set the "captured" status for this frame (see
  // useSmartCapture's `runAutoSnap`). A failure here must not undo any of
  // that — the hook catches it separately and reports it as its own error
  // rather than autoSnapFailed.
  const onCaptured = useCallback(async () => {
    const files = await refreshDataset();
    if (files) setSelected(files.length);
  }, [datasetPath]);

  // `guidance` is fed to the hook through a ref rather than directly, because
  // `coverage` (below) is computed FROM `capture.counts`, and `coverage.guidance`
  // would otherwise create a render cycle. The hook only uses it to steer spoken
  // directions, so a value that lags one render behind is harmless — this
  // matches the pre-refactor page, where the ref was also synced a render late.
  const guidanceRef = useRef(null);
  const capture = useSmartCapture({
    enabled: autoCapture,
    liveDevice, datasetPath, autoRate,
    board, geometry, profile: FISHEYE_PROFILE,
    mode: captureMode === 'guided' ? 'guided' : 'sweep',
    mirror,
    guidance: guidanceRef.current,
    doSnap: snapOnce,
    onCaptured,
    say, t, setStatus,
  });

  // Polar coverage. Two sources, picked by phase:
  //   • after a solve → bin the per-frame residuals into rings×sectors, which
  //     also yields per-cell quality (mean reprojection error) for colouring.
  //   • during capture → the live `capture.counts` tally from the hook, so the
  //     dartboard fills in real time as the user snaps. `guidance` flags the
  //     emptiest cell.
  const coverage = useMemo(() => {
    const total = totalPolarCells();
    if (result?.per_frame_residuals?.length && covCircle) {
      const counts = new Array(total).fill(0);
      const errSum = new Array(total).fill(0);
      for (const frame of result.per_frame_residuals) {
        if (!frame) continue;
        for (const c of frame) {
          const idx = polarCellAt(c[0], c[1], covCircle);
          if (idx == null) continue;
          counts[idx] += 1;
          const ex = c[2], ey = c[3];
          if (Number.isFinite(ex) && Number.isFinite(ey)) errSum[idx] += Math.hypot(ex, ey);
        }
      }
      const cells = counts.map(n => n > 0);
      const meanErr = counts.map((n, i) => (n > 0 ? errSum[i] / n : null));
      const filled = cells.reduce((n, on) => n + (on ? 1 : 0), 0);
      return { cells, counts, meanErr, guidance: null, filled, total, percent: Math.round((filled / total) * 100) };
    }
    const cells = capture.counts.map(c => c > 0);
    const filled = cells.reduce((n, on) => n + (on ? 1 : 0), 0);
    return {
      cells, counts: capture.counts, meanErr: null,
      guidance: geometry.pickGuidance(capture.counts),
      filled, total, percent: Math.round((filled / total) * 100),
    };
  }, [result, covCircle, capture.counts, geometry]);

  useEffect(() => { guidanceRef.current = coverage.guidance; }, [coverage.guidance]);

  const onDrop = async () => {
    if (!selectedPath) { setStatus(t('common.noFrameSelected')); return; }
    const name = selectedPath.split('/').pop();
    try {
      const r = await api.deleteFrame(selectedPath);
      pushUndo({ kind: 'drop', path: selectedPath, trashPath: r.trash_path });
      const files = await refreshDataset();
      const newLen = files?.length ?? 0;
      setSelected(Math.min(Math.max(1, selected), Math.max(1, newLen)));
      if (newLen === 0) setViewMode('live');
      setStatus(t('common.dropped', { name }));
    } catch (e) { setStatus(t('common.dropFailed', { error: e.message }), true); }
  };

  // Undo the last destructive action. Snap-undo trashes the just-snapped file;
  // drop-undo restores from the .trash/ directory it landed in.
  const onUndo = async () => {
    const stack = undoStackRef.current;
    if (!stack.length) { setStatus(t('common.nothingToUndo')); return; }
    const entry = stack.pop();
    try {
      if (entry.kind === 'snap') {
        await api.deleteFrame(entry.path);
        await refreshDataset();
        setStatus(t('common.undidSnap', { name: entry.path.split('/').pop() }));
      } else if (entry.kind === 'drop') {
        await api.restoreFrame(entry.trashPath, entry.path);
        await refreshDataset();
        setStatus(t('common.undidDrop', { name: entry.path.split('/').pop() }));
      } else if (entry.kind === 'clear') {
        for (const e of entry.entries) await api.restoreFrame(e.trashPath, e.path);
        await refreshDataset();
        setStatus(t('common.undidClear', { count: entry.entries.length }));
      }
    } catch (e) {
      stack.push(entry);  // put it back so the user can retry
      setStatus(t('common.undoFailed', { error: e.message }), true);
    }
  };

  // Keyboard shortcuts: ←/→ step through dataset frames; space snaps a new frame.
  // Skip while focus is on a form control so typing in fields stays unaffected.
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
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDropRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  // Keep refs pointed at the latest closures so the global keydown handler
  // always invokes the up-to-date functions (which close over liveDevice / datasetPath).
  useEffect(() => { onSnapRef.current = onSnap; });
  useEffect(() => { onUndoRef.current = onUndo; });
  useEffect(() => { onDropRef.current = onDrop; });
  useEffect(() => { onRunRef.current = onRun; });

  const onRun = async () => {
    if (!datasetPath) { setStatus(t('common.pickDatasetFolder'), true); return; }
    setBusy(true); setStatus(t('fisheye.solving')); say('solveStart');
    try {
      const res = await api.calibrate('fisheye', {
        board: boardPayload(),
        model,
        dataset_path: datasetPath,
      });
      setResult(res);
      setStatus(res.ok ? t('fisheye.rmsResult', { rms: res.rms.toFixed(4), message: res.message }) : t('common.failed', { message: res.message }), !res.ok);
      say(res.ok ? 'solveOk' : 'solveFail');
    } catch (e) { setStatus(t('common.error', { error: e.message }), true); say('solveFail'); } finally { setBusy(false); }
  };

  const onSave = async () => {
    if (!result?.ok) { setStatus(t('common.nothingToSave')); return; }
    // Extra layer (not a replacement): when the source is a ROS2 camera, the mount
    // (head/left/right/back) lives in the topic, so also merge this solve into the
    // robot's shared camera_intrix.yaml — other mounts + their sn untouched, old
    // file backed up. The original pick-a-file YAML export below is unchanged.
    const slot = cameraSlotFromSource(liveDevice, datasetPath);
    let extra = '', extraErr = false;
    if (slot) {
      try {
        const r = await api.exportCameraIntrix({
          slot,
          K: result.K,
          D: result.D ?? [],
          image_size: result.image_size ?? null,
        });
        extra = ' · ' + t('fisheye.wroteCameraIntrix', { slot, path: r.path });
      } catch (e) {
        extra = ' · ' + t('fisheye.cameraIntrixFailed', { error: e.message });
        extraErr = true;
      }
    }
    const p = await pickSaveFile({ defaultPath: 'fisheye.yaml' });
    // Dialog cancelled — the camera_intrix write (if any) already happened, so
    // surface that rather than dropping the feedback silently.
    if (!p) { if (extra) setStatus(extra.slice(3), extraErr); return; }
    try {
      await api.saveCalibration({
        path: p, kind: 'fisheye',
        result, board: boardPayload(), dataset_path: datasetPath || null,
      });
      const fmt = p.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      setStatus(t('common.savedFmt', { fmt, path: p }) + extra);
    } catch (e) { setStatus(t('common.saveFailed', { error: e.message }), true); }
  };

  const onLoad = async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      const Kload = d.K || null;
      const Dload = d.D || [];
      setResult({
        ok: true,
        rms: d.rms ?? 0,
        K: Kload, D: Dload,
        image_size: d.image_size || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0,
        message: `loaded from ${p}`,
      });
      if (d.dataset_path && d.dataset_path !== datasetPath) {
        // Tell the dataset-listing effect not to clear the result we just set above.
        skipResultResetRef.current = true;
        setDatasetPath(d.dataset_path);
      }
      // Snap the viewport into split + live so the user immediately sees the
      // raw camera + rectified preview built from the just-loaded intrinsics.
      setView('split');
      setViewMode('live');
      const fmt = p.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      const fxRound = Kload?.[0]?.[0]?.toFixed?.(1) ?? '?';
      const rmsRound = (d.rms ?? 0).toFixed(3);
      setStatus(t('fisheye.loadedDetail', { fmt, name: p.split('/').pop(), rms: rmsRound, fx: fxRound }));
    } catch (e) { setStatus(t('common.loadFailed', { error: e.message }), true); }
  };

  const rms = result?.ok ? result.rms : 0;
  // Fisheye reprojection-error thresholds (pixels). Same scale as pinhole.
  const PX_OK = 0.25, PX_WARN = 0.5;
  const rmsKind = result?.ok ? trafficKindForRms(rms, PX_OK, PX_WARN) : 'idle';
  const Kraw = result?.K ?? null;
  const K44 = Kraw
    ? [[...Kraw[0], 0], [...Kraw[1], 0], [...Kraw[2], 0], [0,0,0,1]]
    : ZERO_K;
  const D = result?.D ?? [];

  const histData = result?.per_frame_err ?? [];
  const sparkData = useMemo(() => frames.map(f => f.err), [frames]);

  const selectedPath = datasetFiles[selected - 1];
  const calibrated = !!(result?.ok && Kraw && D.length);
  const canRectifyFrame = !!(calibrated && selectedPath);

  const emptyCell = (text) => (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      width:'100%', height:'100%', color:'var(--view-text-2)',
      fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign: 'center',
    }}>{text}</div>
  );

  // Live preview takes priority when the user is in 'live' mode OR when there's no dataset
  // to fall back on. Snapping a frame flips viewMode to 'frame' so they see the saved image;
  // clicking "👁 live preview" puts them back to live.
  const showLive = liveDevice && (viewMode === 'live' || datasetFiles.length === 0);

  // Guided overlay descriptor for the live frame: the active step's region + pose
  // glyph, or {done:true} once the checklist is exhausted. null in polar mode.
  const guidedStepNow = GUIDED_STEPS[capture.guidedProgress.step];
  const guidedOverlay = guidedMode
    ? (guidedStepNow
        ? { region: guidedStepNow.region, glyph: guidedStepNow.glyph,
            pose: guidedStepNow.pose, scale: guidedStepNow.scale ?? null,
            group: guidedStepNow.group, done: false }
        : { done: true })
    : null;

  const rawCell = (
    <div className="vp-cell" key="raw">
      <span className="vp-label">
        {showLive ? t('fisheye.liveLabel', { device: liveDevice }) : t('fisheye.rawDistorted')}
      </span>
      {showLive ? (
        liveDetect
          ? <LiveDetectedFrame device={liveDevice} board={board}
                showCorners={showBoard} showOrigin={true}
                onMeta={capture.onMeta}
                onCircle={setCircle}
                showPolarGrid={showPolar}
                polarCells={coverage.cells}
                polarCounts={coverage.counts}
                polarGuidance={coverage.guidance}
                rings={RINGS} sectors={SECTORS}
                guided={guidedOverlay}
                showFootprint={showFootprint}
                mirror={mirror}/>
          : <LivePreview device={liveDevice} mirror={mirror}/>
      ) : datasetFiles.length > 0 && selectedPath ? (
        <DetectedFrame
          path={selectedPath}
          board={board}
          showCorners={showBoard}
          showOrigin={true}
          overlay={showResid ? 'residuals' : 'none'}
          residuals={residualsByPath?.get(selectedPath)}/>
      ) : (
        emptyCell(t('fisheye.connectOrLoad'))
      )}
      {showLive && liveDetect && autoCapture && capture.autoHud && (() => {
        const autoHud = capture.autoHud;
        const r = autoHud.reason;
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
            {autoHud.guidedLabel && (
              <div style={{ color: 'var(--text)', fontSize: 12, fontWeight: 700 }}>{autoHud.guidedLabel}</div>
            )}
            <div><span style={{ color }}>⦿ {t('fisheye.autoCapture')} · {t(`fisheye.auto_${r}`)}</span>
              {typeof autoHud.tilt === 'number' && <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>  ∠{autoHud.tilt.toFixed(0)}°</span>}
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.18)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round((autoHud.dwell || 0) * 100)}%`, background: 'var(--ok)', transition: 'width 80ms linear' }}/>
            </div>
          </div>
        );
      })()}
      <div className="vp-corner-read">
        <div>fx <b>{K44[0][0].toFixed(2)}</b>  fy <b>{K44[1][1].toFixed(2)}</b></div>
        <div>cx <b>{K44[0][2].toFixed(2)}</b>  cy <b>{K44[1][2].toFixed(2)}</b></div>
        <div>k₁ <b>{(D[0] ?? 0).toFixed(4)}</b>  k₂ <b>{(D[1] ?? 0).toFixed(4)}</b></div>
        <div>k₃ <b>{(D[2] ?? 0).toFixed(4)}</b>  k₄ <b>{(D[3] ?? 0).toFixed(4)}</b></div>
      </div>
    </div>
  );

  // Rectified cell. Source picks itself: live mode + calibrated → live MJPEG rectified;
  // dataset frame selected + calibrated → that frame rectified; otherwise placeholder.
  const rectifiedCell = (m, label) => {
    const useLive = showLive && calibrated && liveDevice;
    let body;
    if (useLive) {
      body = <RectifiedLivePreview device={liveDevice} K={Kraw} D={D}
                balance={balance} fovScale={fovScale} method={m}/>;
    } else if (canRectifyFrame) {
      body = <RectifiedFrame path={selectedPath} K={Kraw} D={D}
                balance={balance} fovScale={fovScale} method={m}/>;
    } else if (calibrated) {
      body = emptyCell(t('fisheye.connectOrSelectFrame'));
    } else {
      body = emptyCell(t('fisheye.runToRectify'));
    }
    return (
      <div className="vp-cell" key={m}>
        <span className="vp-label">{useLive ? t('fisheye.liveSuffix', { label }) : label}</span>
        {body}
        <div className="vp-corner-read">
          <div>{t('fisheye.method')} <b>{m === 'undistort' ? t('fisheye.methodCvUndistort') : t('fisheye.methodRemapFull')}</b></div>
          <div>{t('fisheye.balanceRead')} <b>{balance.toFixed(2)}</b>  {t('fisheye.fovScaleRead')} <b>{fovScale.toFixed(2)}</b></div>
        </div>
      </div>
    );
  };

  const rectCell = rectifiedCell(method, method === 'undistort' ? t('fisheye.rectifiedUndistort') : t('fisheye.rectifiedRemap'));

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>{t('fisheye.railTitle')}</span>
          <span className="mono" style={{color: result?.ok ? trafficColor(rmsKind) : 'var(--text-4)'}}>
            {result?.ok ? t('common.rmsPx', { rms: result.rms.toFixed(2) }) : t('common.idle')}
          </span>
        </div>
        <div className="rail-scroll">
          <CameraSourcePanel source={cam} onLivePreview={() => setViewMode('live')}/>
          <Section title={t('fisheye.dataset')} hint={datasetFiles.length ? t('common.images', { count: datasetFiles.length }) : t('common.notLoaded')}>
            <Field label={t('common.folder')}>
              <input className="input" value={datasetPath} placeholder={t('framePlaceholder.pathOrPlaceholder')}
                     onChange={e => setDatasetPath(e.target.value)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={onPickFolder}>{t('common.pickFolder')}</button>
              <button className="btn ghost" onClick={onClear}>{t('common.clear')}</button>
            </div>
            {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>{status}</div>}
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title={t('fisheye.projectionModel')} hint={model}>
            <Seg value={model} onChange={setModel} full options={[
              {value:'equidistant',label:t('fisheye.modelEquidistant')},{value:'kb',label:t('fisheye.modelKb')},{value:'omni',label:t('fisheye.modelOmni')}
            ]}/>
            <Chk checked={true} onChange={()=>{}}>{t('fisheye.estimateK')}</Chk>
            <Chk checked={false} onChange={()=>{}}>{t('fisheye.includeXi')}</Chk>
            <Chk checked={true} onChange={()=>{}}>{t('fisheye.bundleAdjust')}</Chk>
            <Chk checked={true} onChange={()=>{}}>{t('fisheye.applyFovMask')}</Chk>
          </Section>
          <Section title={t('fisheye.undistortionPreview')}>
            <Field label={t('fisheye.balance')}>
              <div className="slider-row">
                <input type="range" min="0" max="100" value={Math.round(balance * 100)}
                       onChange={e => setBalance(+e.target.value / 100)}/>
                <span className="mono">{balance.toFixed(2)}</span>
              </div>
            </Field>
            <Field label={t('fisheye.fovScale')}>
              <div className="slider-row">
                <input type="range" min="10" max="300" value={Math.round(fovScale * 100)}
                       onChange={e => setFovScale(+e.target.value / 100)}/>
                <span className="mono">{fovScale.toFixed(2)}</span>
              </div>
            </Field>
          </Section>
          <CaptureControls
            autoCapture={autoCapture}
            onAuto={(v) => {
              setAutoCapture(v);
              // Auto-capture relies on the per-frame detection stream, so flip
              // liveDetect on alongside it. Leaving liveDetect off would render
              // the toggle silently inert.
              if (v) setLiveDetect(true);
            }}
            autoRate={autoRate}
            onAutoRate={setAutoRate}
            onSnap={onSnap} onDrop={onDrop}
            coverage={coverage.percent}
            polar={{ cells: coverage.cells, counts: coverage.counts, meanErr: coverage.meanErr,
                     guidance: coverage.guidance, rings: RINGS, sectors: SECTORS }}
            okBelow={PX_OK} warnBelow={PX_WARN}/>
        </div>
        <SolverButton onSolve={onRun} busy={busy}
          status={status}
          statusKind={
            !status ? undefined :
            statusErr ? 'err' :
            result?.ok ? 'ok' : 'warn'
          }/>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value={view} onChange={setView} options={[
            {value:'split',label:t('fisheye.viewSplit')},
            {value:'raw',label:t('fisheye.viewRaw')},
            {value:'rect',label:t('fisheye.viewRectified')},
            {value:'compare',label:t('fisheye.viewCompare')},
          ]}/>
          {view !== 'compare' && view !== 'raw' && (
            <Seg value={method} onChange={setMethod} options={[
              {value:'remap',label:t('fisheye.methodRemap')},
              {value:'undistort',label:t('fisheye.methodUndistort')},
            ]}/>
          )}
          <Chk checked={showBoard} onChange={setShowBoard}>{t('fisheye.board')}</Chk>
          <Chk checked={showResid} onChange={setShowResid}>{t('fisheye.residuals')}</Chk>
          <Chk checked={liveDetect} onChange={setLiveDetect}>{t('fisheye.detectLive')}</Chk>
          <Seg value={captureMode} onChange={(v) => { setCaptureMode(v); setLiveDetect(true); }} options={[
            {value:'polar',label:t('fisheye.captureModePolar')},
            {value:'guided',label:t('fisheye.captureModeGuided')},
          ]}/>
          <Chk checked={showFootprint} onChange={(v) => { setShowFootprint(v); if (v) setLiveDetect(true); }}>{t('fisheye.footprint')}</Chk>
          <Chk checked={mirror} onChange={setMirror}>{t('fisheye.mirror')}</Chk>
          <div className="spacer"/>
          <div className="read">
            {streamInfo?.open && (
              <>{streamInfo.width}×{streamInfo.height} · <b>{streamInfo.capture_fps?.toFixed(1) ?? '—'}</b> fps · </>
            )}
            {result?.ok ? <>rms <b style={{color: trafficColor(rmsKind)}}>{result.rms.toFixed(3)}</b> px</> : <>{t('fisheye.noCalibrationYet')}</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selected} onSelect={(id) => { setSelected(id); setViewMode('frame'); }} coverage={coverage.percent}
          errUnit=" px" errHint={t('fisheye.perFrameErrHint')}/>
        {(() => {
          // Pick which cells to render. Until we have intrinsics, the rectified cell is
          // not meaningful — collapse to the raw cell at full width regardless of view mode.
          let cells;
          if (!calibrated) {
            cells = [rawCell];
          } else if (view === 'compare') {
            cells = [
              rectifiedCell('remap', t('fisheye.rectifiedRemapFull')),
              rectifiedCell('undistort', t('fisheye.rectifiedUndistortFull')),
            ];
          } else if (view === 'raw') {
            cells = [rawCell];
          } else if (view === 'rect') {
            cells = [rectCell];
          } else { // 'split'
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
        <div className="rail-header"><span>{t('fisheye.results')}</span>
          <span className="mono" style={{color: result?.ok ? trafficColor(rmsKind) : 'var(--text-4)'}}>
            {result?.ok ? `● ${rms.toFixed(2)} px` : busy ? t('common.solvingDot') : t('common.idleDot')}
          </span>
        </div>
        <div className="rail-scroll">
          <ErrorPanel rms={rms} frames={sparkData} histData={histData}
            okBelow={PX_OK} warnBelow={PX_WARN}/>
          <Section title={t('fisheye.kFisheye')}>
            <Matrix m={K44}/>
          </Section>
          <Section title={t('fisheye.distortionK')} hint={model}>
            <div className="mono" style={{ fontSize: 11.5, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
              {['k₁','k₂','k₃','k₄'].map((lbl, i) => (
                <React.Fragment key={i}>
                  <span style={{color:'var(--text-3)'}}>{lbl}</span>
                  <span style={{textAlign:'right'}}>{(D[i] ?? 0).toFixed(5)}</span>
                </React.Fragment>
              ))}
            </div>
          </Section>
          <SolverPanel
            iters={result?.iterations ?? 0}
            cost={result?.final_cost ?? 0} costUnit="px²"
            cond={0}
            algo={t('fisheye.algo')}/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoad}>{t('common.load')}</button>
          <button className="btn primary" style={{flex:1}} onClick={onSave} disabled={!result?.ok}>{t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}
