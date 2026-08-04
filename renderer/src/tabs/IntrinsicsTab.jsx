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
import { computeCoverage } from '../lib/coverage.js';
import { extentFromImageSize } from '../lib/boardMetrics.js';
import { GUIDED_STEPS, PINHOLE_PROFILE } from '../lib/guidedSequence.js';
import { makeRectGeometry } from '../lib/smartCapture/geometry.js';
import { useSmartCapture } from '../lib/smartCapture/useSmartCapture.js';
import { speak } from '../lib/voice.js';
import { useVoiceCommands } from '../lib/voiceControl.js';
import { DEFAULT_CHESS_BOARD } from '../lib/board.js';
import { confirm } from '../components/confirm.jsx';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

const ZERO_K = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]];

export function IntrinsicsTab({ active, tweaks }) {
  const { t } = useTranslation();
  const [board, setBoard] = useState(DEFAULT_CHESS_BOARD);
  const [autoCapture, setAuto] = useState(false);
  const [autoRate, setAutoRate] = useState(0.5);
  const [view, setView] = useState('split');                 // 'split' | 'raw' | 'rect' | 'compare'
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
  // status carries a message plus an explicit error flag, so the solver-status
  // color is language-independent (no regex-matching the localized text).
  const [status, setStatusMsg] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const setStatus = (msg, isErr = false) => { setStatusMsg(msg); setStatusErr(isErr); };

  const [viewMode, setViewMode] = useState('live');          // 'live' | 'frame'
  const [liveDetect, setLiveDetect] = useState(false);
  // 二选一的自动检测/叠加模式：'sweep' 矩形覆盖网格（手持扫覆盖），
  // 'guided' 文档引导序列（按手册清单逐个位置/动作各拍两张）。跨会话记住。
  const [captureMode, setCaptureMode] = useState(() => localStorage.getItem('calib_intrinsics_capmode') || 'sweep');
  const guidedMode = captureMode === 'guided';
  const [showFootprint, setShowFootprint] = useState(false);   // 检测可达足迹热力
  // 镜像翻转：仅用于实时预览画面，不影响抓拍帧/校正视图/保存的原图。
  const [mirror, setMirror] = useState(() => localStorage.getItem('calib_intrinsics_mirror') === '1');

  // When onLoad sets datasetPath from a loaded calibration, the dataset-listing
  // effect would otherwise wipe the just-loaded result. This ref tells the effect
  // "skip the result reset on the next listing — the result is fresh, not stale."
  const skipResultResetRef = useRef(false);

  useEffect(() => { localStorage.setItem('calib_intrinsics_capmode', captureMode); }, [captureMode]);
  useEffect(() => { localStorage.setItem('calib_intrinsics_mirror', mirror ? '1' : '0'); }, [mirror]);

  // per-detected-path maps so FrameStrip / DetectedFrame align even when some frames skipped.
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

  const frames = useMemo(() => datasetFiles.map((p, i) => ({
    id: i + 1, err: errByPath?.get(p) ?? 0, tx: 0, ty: 0, rot: 0,
  })), [datasetFiles, errByPath]);

  const [selectedFrame, setSelected] = useState(1);

  const sparkData = useMemo(() => frames.map(f => f.err), [frames]);
  const histData = result?.per_frame_err ?? [];

  const rms = result?.ok ? result.rms : 0;
  const Kraw = result?.K;
  const K = Kraw
    ? [[...Kraw[0], 0], [...Kraw[1], 0], [...Kraw[2], 0], [0, 0, 0, 1]]
    : ZERO_K;
  const D = result?.D ?? [];

  const cam = useCameraSource({
    pollEnabled: viewMode === 'live' || datasetFiles.length === 0,
  });
  const { liveDevice, streamInfo } = cam;

  const calibrated = !!(result?.ok && result?.K && D.length);
  const selectedPath = datasetFiles[selectedFrame - 1];
  const canRectifyFrame = !!(calibrated && selectedPath);
  const showLive = liveDevice && (viewMode === 'live' || datasetFiles.length === 0);

  useEffect(() => {
    if (!datasetPath) return;
    let cancelled = false;
    api.listDataset(datasetPath).then(r => {
      if (cancelled) return;
      setDatasetFiles(r.files);
      setStatus(t('common.imagesInDataset', { count: r.count }));
      setSelected(1);
      if (skipResultResetRef.current) {
        // onLoad just brought a fresh calibration in tandem with this dataset
        // path; don't wipe it.
        skipResultResetRef.current = false;
      } else {
        setResult(null);
      }
    }).catch(e => !cancelled && setStatus(t('common.listingFailed', { error: e.message }), true));
    return () => { cancelled = true; };
  }, [datasetPath]);

  // Refs the global keydown handler reads from so it always sees fresh closures
  // without re-attaching the listener on every render.
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
    calibrate: () => { if (acceptVoiceCommand('calibrate')) onRunRef.current?.(); },
    photo: () => { if (acceptVoiceCommand('snap')) onSnapRef.current?.(); },
    capture: () => { if (acceptVoiceCommand('snap')) onSnapRef.current?.(); },
  }), [acceptVoiceCommand]);

  useVoiceCommands(active === 'intrinsics' && !!tweaks?.voiceCommands, voiceHandlers);

  // Bounded undo stack of {kind: 'snap'|'drop', path, trashPath?}.
  const UNDO_LIMIT = 20;
  const undoStackRef = useRef([]);
  const pushUndo = (entry) => {
    const stack = undoStackRef.current;
    stack.push(entry);
    if (stack.length > UNDO_LIMIT) stack.shift();
  };

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

  const onDrop = async () => {
    const path = datasetFiles[selectedFrame - 1];
    if (!path) { setStatus(t('common.noFrameSelected')); return; }
    const name = path.split('/').pop();
    try {
      const r = await api.deleteFrame(path);
      pushUndo({ kind: 'drop', path, trashPath: r.trash_path });
      const files = await refreshDataset();
      const newLen = files?.length ?? 0;
      setSelected(Math.min(Math.max(1, selectedFrame), Math.max(1, newLen)));
      if (newLen === 0) setViewMode('live');
      setStatus(t('common.dropped', { name }));
    } catch (e) { setStatus(t('common.dropFailed', { error: e.message }), true); }
  };

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
      stack.push(entry);
      setStatus(t('common.undoFailed', { error: e.message }), true);
    }
  };

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

  const boardPayload = () => ({
    type: board.type,
    cols: board.cols,
    rows: board.rows,
    square: board.sq,
    marker: board.marker ?? null,
    dictionary: 'DICT_5X5_100',
  });

  // The region the capture grid is laid over: the whole frame. A pinhole lens has
  // no image circle to detect, so this comes straight from the stream/solve size.
  const imgW = result?.image_size?.[0] ?? (streamInfo?.open ? streamInfo.width : null);
  const imgH = result?.image_size?.[1] ?? (streamInfo?.open ? streamInfo.height : null);
  const imgSizeForCov = imgW && imgH ? [imgW, imgH] : null;
  const geometry = useMemo(() => makeRectGeometry(imgSizeForCov), [imgW, imgH]);
  const guidedExtent = useMemo(() => extentFromImageSize(imgSizeForCov), [imgW, imgH]);

  // `guidance` reaches the state machine one render late (it only drives the
  // spoken direction, never a capture decision) — this ref breaks the cycle
  // between "counts feed coverage" and "coverage feeds guidance".
  const guidanceRef = useRef(null);

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
  // step, spoken the cue, and set the "captured" status for this frame. A
  // failure here must not undo any of that — the hook catches it separately
  // and reports it as its own error rather than autoSnapFailed.
  const onCaptured = useCallback(async () => {
    const files = await refreshDataset();
    if (files) setSelected(files.length);
  }, [datasetPath]);

  const capture = useSmartCapture({
    enabled: autoCapture,
    liveDevice, datasetPath, autoRate,
    board, geometry, profile: PINHOLE_PROFILE,
    mode: guidedMode ? 'guided' : 'sweep',
    mirror,
    guidance: guidanceRef.current,
    doSnap: snapOnce,
    onCaptured,
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
  // Keep refs pointed at the latest closures so the global keydown handler
  // always invokes the up-to-date functions (which close over liveDevice / datasetPath).
  useEffect(() => { onSnapRef.current = onSnap; });
  useEffect(() => { onUndoRef.current = onUndo; });
  useEffect(() => { onDropRef.current = onDrop; });
  useEffect(() => { onRunRef.current = onRun; });

  const onSave = async () => {
    if (!result?.ok) { setStatus(t('common.nothingToSave')); return; }
    const p = await pickSaveFile({ defaultPath: 'intrinsics.yaml' });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'intrinsics',
        result, board: boardPayload(), dataset_path: datasetPath || null,
      });
      const fmt = p.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      setStatus(t('common.savedFmt', { fmt, path: p }));
    } catch (e) { setStatus(t('common.saveFailed', { error: e.message }), true); }
  };

  const onLoad = async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      const Kload = d.K || null;
      setResult({
        ok: true,
        rms: d.rms ?? 0,
        K: Kload,
        D: d.D || [],
        image_size: d.image_size || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [],
        detected_paths: [],
        iterations: 0, final_cost: 0,
        message: `loaded from ${p}`,
      });
      if (d.dataset_path && d.dataset_path !== datasetPath) {
        // Tell the dataset-listing effect not to clear the result we just set above.
        skipResultResetRef.current = true;
        setDatasetPath(d.dataset_path);
      }
      // Snap the viewport into split + live so the user immediately sees the raw
      // camera + undistorted preview built from the just-loaded intrinsics.
      setView('split');
      setViewMode('live');
      const fmt = p.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      const fxRound = Kload?.[0]?.[0]?.toFixed?.(1) ?? '?';
      const rmsRound = (d.rms ?? 0).toFixed(3);
      setStatus(t('intrinsics.loadedDetail', { fmt, name: p.split('/').pop(), rms: rmsRound, fx: fxRound }));
    } catch (e) { setStatus(t('common.loadFailed', { error: e.message }), true); }
  };

  const onRun = async () => {
    if (!datasetPath) {
      setStatus(t('common.pickDatasetFolder'), true);
      return;
    }
    setBusy(true);
    setStatus(t('intrinsics.detectingSolving'));
    say('solveStart');
    try {
      const res = await api.calibrate('intrinsics', {
        board: boardPayload(),
        model,
        dataset_path: datasetPath,
      });
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
  };

  const converged = result?.ok ?? false;
  // Pinhole reprojection-error thresholds (pixels).
  const PX_OK = 0.25, PX_WARN = 0.5;
  const rmsKind = converged ? trafficKindForRms(rms, PX_OK, PX_WARN) : 'idle';

  const emptyCell = (text) => (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      width:'100%', height:'100%', color:'var(--view-text-2)',
      fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign:'center',
    }}>{text}</div>
  );

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

  const rawCell = (
    <div className="vp-cell" key="raw">
      <span className="vp-label">
        {showLive
          ? (liveDetect
              ? t('intrinsics.liveDetectLabel', { device: liveDevice })
              : t('intrinsics.liveLabel', { device: liveDevice }))
          : t('intrinsics.raw')}
      </span>
      {showLive ? (
        liveDetect
          ? <LiveDetectedFrame device={liveDevice} board={board}
                showCorners={showBoard} showOrigin={showOrigin}
                onMeta={capture.onMeta}
                coverageCells={coverage.cells}
                coverageCounts={coverage.counts}
                showCoverageGrid={!guidedMode}
                guided={guidedOverlay}
                guidedExtent={guidedExtent}
                showFootprint={showFootprint}
                mirror={mirror}/>
          : <LivePreview device={liveDevice} mirror={mirror}/>
      ) : datasetFiles.length > 0 && selectedPath ? (
        <DetectedFrame
          path={selectedPath}
          board={board}
          showCorners={showBoard}
          showOrigin={showOrigin}
          overlay={showResid ? 'residuals' : 'none'}
          residuals={residualsByPath?.get(selectedPath)}/>
      ) : (
        emptyCell(t('intrinsics.connectOrLoad'))
      )}
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
      <div className="vp-corner-read">
        <div>fx <b>{K[0][0].toFixed(2)}</b>  fy <b>{K[1][1].toFixed(2)}</b></div>
        <div>cx <b>{K[0][2].toFixed(2)}</b>  cy <b>{K[1][2].toFixed(2)}</b></div>
        <div>k₁ <b>{(D[0] ?? 0).toFixed(3)}</b>  k₂ <b>{(D[1] ?? 0).toFixed(3)}</b></div>
        <div>p₁ <b>{(D[2] ?? 0).toFixed(4)}</b>  p₂ <b>{(D[3] ?? 0).toFixed(4)}</b></div>
      </div>
    </div>
  );

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

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>{t('intrinsics.railTitle')}</span>
          <span className="mono" style={{color: converged ? trafficColor(rmsKind) : 'var(--text-4)'}}>
            {result?.ok ? t('common.rmsPx', { rms: result.rms.toFixed(2) }) : t('common.idle')}
          </span>
        </div>
        <div className="rail-scroll">
          <CameraSourcePanel source={cam} onLivePreview={() => setViewMode('live')}/>
          <Section title={t('intrinsics.dataset')} hint={datasetFiles.length ? t('common.images', { count: datasetFiles.length }) : t('common.notLoaded')}>
            <Field label={t('common.folder')}>
              <input className="input" value={datasetPath} placeholder={t('framePlaceholder.pathOrPlaceholder')}
                     onChange={e => setDatasetPath(e.target.value)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={onPickFolder}>{t('common.pickFolder')}</button>
              <button className="btn ghost" onClick={onClear}>{t('common.clear')}</button>
            </div>
            {status && <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)', marginTop: 2 }}>{status}</div>}
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title={t('intrinsics.model')} hint={model}>
            <Seg value={model} onChange={setModel} full options={[
              {value:'pinhole-k3',label:t('intrinsics.modelK3')},{value:'pinhole-k5',label:t('intrinsics.modelK5')},{value:'pinhole-rt',label:t('intrinsics.modelRational')}
            ]}/>
          </Section>
          <Section title={t('intrinsics.undistortionPreview')}>
            <Field label={t('intrinsics.alpha')}>
              <div className="slider-row">
                <input type="range" min="0" max="100" value={Math.round(alpha * 100)}
                       onChange={e => setAlpha(+e.target.value / 100)}/>
                <span className="mono">{alpha.toFixed(2)}</span>
              </div>
            </Field>
          </Section>
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
          <Chk checked={showBoard} onChange={setShowBoard}>{t('intrinsics.board')}</Chk>
          <Chk checked={showOrigin} onChange={setShowOrigin}>{t('intrinsics.origin')}</Chk>
          <Chk checked={showResid} onChange={setShowResid}>{t('intrinsics.residuals')}</Chk>
          <Chk checked={liveDetect} onChange={setLiveDetect}>{t('intrinsics.detectLive')}</Chk>
          <Seg value={captureMode} onChange={(v) => { setCaptureMode(v); setLiveDetect(true); }} options={[
            {value:'sweep',label:t('intrinsics.captureModeSweep')},
            {value:'guided',label:t('intrinsics.captureModeGuided')},
          ]}/>
          <Chk checked={showFootprint} onChange={(v) => { setShowFootprint(v); if (v) setLiveDetect(true); }}>{t('intrinsics.footprint')}</Chk>
          <Chk checked={mirror} onChange={setMirror}>{t('intrinsics.mirror')}</Chk>
          <div className="spacer"/>
          <div className="read">
            {streamInfo?.open && (
              <>{streamInfo.width}×{streamInfo.height} · <b>{streamInfo.capture_fps?.toFixed(1) ?? '—'}</b> fps · </>
            )}
            {datasetFiles.length > 0 && <>{t('intrinsics.frame')} <b>#{selectedFrame.toString().padStart(2,'0')}</b> · </>}
            {result?.ok
              ? <>rms <b style={{color: trafficColor(rmsKind)}}>{rms.toFixed(3)}</b> px</>
              : busy ? <>{t('intrinsics.solvingShort')}</> : <>{t('intrinsics.notCalibrated')}</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selectedFrame} onSelect={(id) => { setSelected(id); setViewMode('frame'); }} coverage={coverage.percent}
          errUnit=" px" errHint={t('intrinsics.perFrameErrHint')}/>
        {(() => {
          // Pick which cells to render. Until we have intrinsics, the undistorted
          // cell is not meaningful — collapse to the raw cell at full width
          // regardless of view mode (matches FisheyeTab).
          let cells;
          if (!calibrated) {
            cells = [rawCell];
          } else if (view === 'compare') {
            cells = [
              undistortedCell('remap', t('intrinsics.undistortedRemapFull')),
              undistortedCell('undistort', t('intrinsics.undistortedUndistortFull')),
            ];
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
          <span>{t('intrinsics.results')}</span>
          <span className="mono" style={{color: converged ? trafficColor(rmsKind) : 'var(--text-4)'}}>
            {converged ? `● ${rms.toFixed(3)} px` : busy ? t('common.solvingDot') : t('common.idleDot')}
          </span>
        </div>
        <div className="rail-scroll">
          <ErrorPanel rms={rms} frames={sparkData} histData={histData}
            okBelow={PX_OK} warnBelow={PX_WARN}/>
          <Section title={t('intrinsics.intrinsicMatrix')}>
            <Matrix m={K}/>
          </Section>
          <Section title={t('intrinsics.distortion')} hint={t('intrinsics.distortionHint')}>
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
            cost={result?.final_cost ?? 0} costUnit="px²"
            cond={0}
            algo={t('intrinsics.algo')}/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display:'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoad}>{t('common.load')}</button>
          <button className="btn primary" style={{flex:1}} onClick={onSave} disabled={!result?.ok}>{t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}
