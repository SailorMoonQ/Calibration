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
import { computeCoverage, cellIndexFor, mergeCornersIntoCells, COVERAGE_COLS, COVERAGE_ROWS } from '../lib/coverage.js';
import { DEFAULT_CHESS_BOARD } from '../lib/board.js';
import { confirm } from '../components/confirm.jsx';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

const ZERO_K = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]];

export function FisheyeTab() {
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
  const [showCovGrid, setShowCovGrid] = useState(true);   // coverage栅格叠加在画面上
  const [showFootprint, setShowFootprint] = useState(false); // 检测可达足迹热力

  // Live capture coverage — grows as the user snaps frames, before any solve.
  // A cell turns on once a snapped frame put a detected corner in it. Reset per
  // dataset (= per capture session). After a solve we switch to the residual-
  // derived coverage (which also carries per-cell quality).
  const [liveCells, setLiveCells] = useState(() => new Array(COVERAGE_COLS * COVERAGE_ROWS).fill(false));
  // Newest detection meta from the live stream, so a manual snap can bin the
  // corners it just saved into liveCells (snap itself returns no corners).
  const latestMetaRef = useRef(null);

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

  // Coverage. Two sources, picked by phase:
  //   • after a solve → bin the per-frame residuals into the 8×5 grid, which
  //     also yields per-cell quality (mean reprojection error) for colouring.
  //   • during capture (no solve yet) → the live `liveCells` accumulator, so the
  //     grid fills in real time as the user snaps instead of staying empty.
  const coverage = useMemo(() => {
    if (result?.per_frame_residuals?.length) {
      const imgSize = result.image_size
        || (streamInfo?.open ? [streamInfo.width, streamInfo.height] : null);
      return computeCoverage(result.per_frame_residuals, imgSize);
    }
    const filled = liveCells.reduce((n, on) => n + (on ? 1 : 0), 0);
    const total = liveCells.length;
    return { cells: liveCells, counts: null, meanErr: null, filled, total, percent: Math.round((filled / total) * 100) };
  }, [result, streamInfo, liveCells]);

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
  const datasetCountRef = useRef(0);
  useEffect(() => { datasetCountRef.current = datasetFiles.length; }, [datasetFiles.length]);

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

  // Auto-capture state. We track which coverage cells have already been "claimed"
  // by a snap this session so the auto-snapper only fires when the user moves the
  // board into an empty cell, instead of spamming the dataset with redundant frames.
  // The set resets when the dataset folder changes (new session).
  const snappedCellsRef = useRef(new Set());
  const lastAutoSnapRef = useRef(0);
  const autoSnapInFlightRef = useRef(false);
  useEffect(() => {
    snappedCellsRef.current = new Set();
    setLiveCells(new Array(COVERAGE_COLS * COVERAGE_ROWS).fill(false));
  }, [datasetPath]);

  // Fold the corners of the just-snapped frame into the live coverage grid.
  // Uses the freshest live-detection meta (snap returns only a file path).
  const markCellsFromSnap = useCallback(() => {
    const meta = latestMetaRef.current;
    if (!meta?.corners?.length || !meta?.image_size) return;
    setLiveCells(prev => mergeCornersIntoCells(prev, meta.corners, meta.image_size));
  }, []);

  const onAutoMeta = useCallback((meta) => {
    // Always stash the freshest meta so a manual snap can bin its corners,
    // even when auto-capture is off.
    latestMetaRef.current = meta;
    if (!autoCapture || !liveDevice || !datasetPath) return;
    const corners = meta?.corners;
    const size = meta?.image_size;
    if (!corners || corners.length < 4 || !size) return;
    const now = performance.now();
    if (now - lastAutoSnapRef.current < autoRate * 1000) return;  // user-tuned debounce
    if (autoSnapInFlightRef.current) return;
    // Centroid of detected corners → cell index.
    let sx = 0, sy = 0;
    for (const c of corners) { sx += c[0]; sy += c[1]; }
    const cx = sx / corners.length, cy = sy / corners.length;
    const idx = cellIndexFor(cx, cy, size);
    if (idx == null) return;
    if (snappedCellsRef.current.has(idx)) return;
    // Commit early so we don't double-fire while the snap roundtrip is in flight.
    autoSnapInFlightRef.current = true;
    lastAutoSnapRef.current = now;
    snappedCellsRef.current.add(idx);
    (async () => {
      try {
        const r = await api.snap(liveDevice, datasetPath);
        pushUndo({ kind: 'snap', path: r.path });
        markCellsFromSnap();
        setStatus(t('common.autoSnapped', { name: r.path.split('/').pop(), cell: idx }));
        const files = await refreshDataset();
        if (files) setSelected(files.length);
      } catch (e) {
        // Roll back the cell so the user can retry that pose.
        snappedCellsRef.current.delete(idx);
        setStatus(t('common.autoSnapFailed', { error: e.message }), true);
      } finally {
        autoSnapInFlightRef.current = false;
      }
    })();
  }, [autoCapture, liveDevice, datasetPath, autoRate]);

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
    try {
      const r = await api.snap(liveDevice, dir);
      pushUndo({ kind: 'snap', path: r.path });
      markCellsFromSnap();
      setStatus(t('common.snapped', { name: r.path.split('/').pop() }));
      if (dir === datasetPath) {
        // Refresh the listing but keep the live view in the cell — the user is mid-capture
        // and shouldn't have the frame jump to the just-saved still. Click a thumbnail in
        // the FrameStrip to inspect a saved frame.
        await refreshDataset();
      }
    } catch (e) { setStatus(t('common.snapFailed', { error: e.message }), true); }
  };
  // Keep refs pointed at the latest closures so the global keydown handler
  // always invokes the up-to-date functions (which close over liveDevice / datasetPath).
  useEffect(() => { onSnapRef.current = onSnap; });
  useEffect(() => { onUndoRef.current = onUndo; });
  useEffect(() => { onDropRef.current = onDrop; });

  const onRun = async () => {
    if (!datasetPath) { setStatus(t('common.pickDatasetFolder'), true); return; }
    setBusy(true); setStatus(t('fisheye.solving'));
    try {
      const res = await api.calibrate('fisheye', {
        board: boardPayload(),
        model,
        dataset_path: datasetPath,
      });
      setResult(res);
      setStatus(res.ok ? t('fisheye.rmsResult', { rms: res.rms.toFixed(4), message: res.message }) : t('common.failed', { message: res.message }), !res.ok);
    } catch (e) { setStatus(t('common.error', { error: e.message }), true); } finally { setBusy(false); }
  };

  const onSave = async () => {
    if (!result?.ok) { setStatus(t('common.nothingToSave')); return; }
    const p = await pickSaveFile({ defaultPath: 'fisheye.yaml' });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'fisheye',
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

  const rawCell = (
    <div className="vp-cell" key="raw">
      <span className="vp-label">
        {showLive ? t('fisheye.liveLabel', { device: liveDevice }) : t('fisheye.rawDistorted')}
      </span>
      {showLive ? (
        liveDetect
          ? <LiveDetectedFrame device={liveDevice} board={board}
                showCorners={showBoard} showOrigin={true}
                onMeta={onAutoMeta}
                coverageCells={coverage.cells}
                covCols={COVERAGE_COLS} covRows={COVERAGE_ROWS}
                showCoverageGrid={showCovGrid}
                showFootprint={showFootprint}/>
          : <LivePreview device={liveDevice}/>
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
            coverage={coverage.percent} coverageCells={coverage.cells}
            coverageMeanErr={coverage.meanErr} okBelow={PX_OK} warnBelow={PX_WARN}/>
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
          <Chk checked={showCovGrid} onChange={(v) => { setShowCovGrid(v); if (v) setLiveDetect(true); }}>{t('fisheye.coverageGrid')}</Chk>
          <Chk checked={showFootprint} onChange={(v) => { setShowFootprint(v); if (v) setLiveDetect(true); }}>{t('fisheye.footprint')}</Chk>
          <div className="spacer"/>
          <div className="read">
            {streamInfo?.open && (
              <>{streamInfo.width}×{streamInfo.height} · <b>{streamInfo.capture_fps?.toFixed(1) ?? '—'}</b> fps · </>
            )}
            {result?.ok ? <>rms <b style={{color: trafficColor(rmsKind)}}>{result.rms.toFixed(3)}</b> px</> : <>{t('fisheye.noCalibrationYet')}</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selected} onSelect={(id) => { setSelected(id); setViewMode('frame'); }} coverage={coverage.percent}/>
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
