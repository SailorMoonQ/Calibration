import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
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
} from '../components/panels.jsx';
import { computeCoverage, cellIndexFor } from '../lib/coverage.js';
import { DEFAULT_CHESS_BOARD } from '../lib/board.js';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

const ZERO_K = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]];

export function FisheyeTab() {
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

  // When onLoad sets datasetPath from a loaded calibration, the dataset-listing effect
  // would normally clear the just-loaded result. This ref tells the effect "skip the
  // result reset on the next listing — the result is fresh, not stale."
  const skipResultResetRef = useRef(false);

  const [datasetPath, setDatasetPath] = useState('');
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

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

  // Coverage: bin every detected corner into the 8×5 grid. Uses streamInfo for
  // the live image_size when no calibration has run yet (otherwise result.image_size).
  const coverage = useMemo(() => {
    const imgSize = result?.image_size
      || (streamInfo?.open ? [streamInfo.width, streamInfo.height] : null);
    return computeCoverage(result?.per_frame_residuals, imgSize);
  }, [result, streamInfo]);

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
      setStatus(`${r.count} images in dataset`);
      setSelected(1);
      if (skipResultResetRef.current) {
        // onLoad just brought a fresh calibration in tandem with this dataset path;
        // don't wipe it.
        skipResultResetRef.current = false;
      } else {
        setResult(null);
      }
    }).catch(e => !cancelled && setStatus(`listing failed: ${e.message}`));
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

  // Refs that the global keydown handler reads from so it always sees the freshest
  // closures without re-attaching the listener on every render.
  const onSnapRef = useRef(null);
  const onUndoRef = useRef(null);
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
  useEffect(() => { snappedCellsRef.current = new Set(); }, [datasetPath]);

  const onAutoMeta = useCallback((meta) => {
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
        setStatus(`auto-snapped → ${r.path.split('/').pop()} (cell ${idx})`);
        const files = await refreshDataset();
        if (files) setSelected(files.length);
      } catch (e) {
        // Roll back the cell so the user can retry that pose.
        snappedCellsRef.current.delete(idx);
        setStatus(`auto-snap failed: ${e.message}`);
      } finally {
        autoSnapInFlightRef.current = false;
      }
    })();
  }, [autoCapture, liveDevice, datasetPath, autoRate]);

  const onDrop = async () => {
    if (!selectedPath) { setStatus('no frame selected to drop'); return; }
    const name = selectedPath.split('/').pop();
    try {
      const r = await api.deleteFrame(selectedPath);
      pushUndo({ kind: 'drop', path: selectedPath, trashPath: r.trash_path });
      const files = await refreshDataset();
      const newLen = files?.length ?? 0;
      setSelected(Math.min(Math.max(1, selected), Math.max(1, newLen)));
      if (newLen === 0) setViewMode('live');
      setStatus(`dropped ${name} · ⌘Z to undo`);
    } catch (e) { setStatus(`drop failed: ${e.message}`); }
  };

  // Undo the last destructive action. Snap-undo trashes the just-snapped file;
  // drop-undo restores from the .trash/ directory it landed in.
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
      stack.push(entry);  // put it back so the user can retry
      setStatus(`undo failed: ${e.message}`);
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        // Refresh the listing but keep the live view in the cell — the user is mid-capture
        // and shouldn't have the frame jump to the just-saved still. Click a thumbnail in
        // the FrameStrip to inspect a saved frame.
        await refreshDataset();
      }
    } catch (e) { setStatus(`snap failed: ${e.message}`); }
  };
  // Keep refs pointed at the latest closures so the global keydown handler
  // always invokes the up-to-date functions (which close over liveDevice / datasetPath).
  useEffect(() => { onSnapRef.current = onSnap; });
  useEffect(() => { onUndoRef.current = onUndo; });

  const onRun = async () => {
    if (!datasetPath) { setStatus('pick a dataset folder first'); return; }
    setBusy(true); setStatus('fisheye solving…');
    try {
      const res = await api.calibrate('fisheye', {
        board: boardPayload(),
        model,
        dataset_path: datasetPath,
      });
      setResult(res);
      setStatus(res.ok ? `rms ${res.rms.toFixed(4)} px · ${res.message}` : `failed: ${res.message}`);
    } catch (e) { setStatus(`error: ${e.message}`); } finally { setBusy(false); }
  };

  const onSave = async () => {
    if (!result?.ok) { setStatus('nothing to save — run calibration first'); return; }
    const p = await pickSaveFile({ defaultPath: 'fisheye.yaml' });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'fisheye',
        result, board: boardPayload(), dataset_path: datasetPath || null,
      });
      const fmt = p.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      setStatus(`saved (${fmt}) → ${p}`);
    } catch (e) { setStatus(`save failed: ${e.message}`); }
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
      setStatus(`loaded (${fmt}) ← ${p.split('/').pop()} · rms ${rmsRound} · fx ${fxRound}`);
    } catch (e) { setStatus(`load failed: ${e.message}`); }
  };

  const rms = result?.ok ? result.rms : 0;
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
  // canRectify is the legacy gate for the dataset-frame rectifier; the live rectifier
  // only needs `calibrated` (it pulls from the live MJPEG).
  const canRectify = canRectifyFrame;

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
        {showLive ? `live · ${liveDevice}` : 'raw · distorted'}
      </span>
      {showLive ? (
        liveDetect
          ? <LiveDetectedFrame device={liveDevice} board={board}
                showCorners={showBoard} showOrigin={true}
                onMeta={onAutoMeta}/>
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
        emptyCell('connect a camera or load a dataset')
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
      body = emptyCell('connect a camera or select a frame to see the rectified view');
    } else {
      body = emptyCell('run calibration to see the rectified view');
    }
    return (
      <div className="vp-cell" key={m}>
        <span className="vp-label">{useLive ? `${label} · live` : label}</span>
        {body}
        <div className="vp-corner-read">
          <div>method <b>{m === 'undistort' ? 'cv2.fisheye.undistortImage' : 'initUndistortRectifyMap + remap'}</b></div>
          <div>balance <b>{balance.toFixed(2)}</b>  fov_scale <b>{fovScale.toFixed(2)}</b></div>
        </div>
      </div>
    );
  };

  const rectCell = rectifiedCell(method, `rectified · ${method === 'undistort' ? 'undistortImage' : 'remap'}`);

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>Fish-eye Intrinsics</span>
          <span className="mono" style={{color:'var(--text-4)'}}>
            {result?.ok ? `rms ${result.rms.toFixed(2)}` : 'idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <CameraSourcePanel source={cam} onLivePreview={() => setViewMode('live')}/>
          <Section title="Dataset" hint={datasetFiles.length ? `${datasetFiles.length} images` : 'not loaded'}>
            <Field label="folder">
              <input className="input" value={datasetPath} placeholder="/path/to/frames/"
                     onChange={e => setDatasetPath(e.target.value)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={onPickFolder}>📁 pick folder</button>
              <button className="btn ghost" onClick={() => { setDatasetPath(''); setDatasetFiles([]); setResult(null); setStatus(''); }}>clear</button>
            </div>
            {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>{status}</div>}
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title="Projection model" hint={model}>
            <Seg value={model} onChange={setModel} full options={[
              {value:'equidistant',label:'equidistant'},{value:'kb',label:'Kannala-Brandt'},{value:'omni',label:'omni (Mei)'}
            ]}/>
            <Chk checked={true} onChange={()=>{}}>estimate k₁…k₄</Chk>
            <Chk checked={false} onChange={()=>{}}>include ξ (mirror)</Chk>
            <Chk checked={true} onChange={()=>{}}>bundle adjust poses</Chk>
            <Chk checked={true} onChange={()=>{}}>apply FOV mask</Chk>
          </Section>
          <Section title="Undistortion preview">
            <Field label="balance">
              <div className="slider-row">
                <input type="range" min="0" max="100" value={Math.round(balance * 100)}
                       onChange={e => setBalance(+e.target.value / 100)}/>
                <span className="mono">{balance.toFixed(2)}</span>
              </div>
            </Field>
            <Field label="fov scale">
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
            {value:'split',label:'split'},
            {value:'raw',label:'raw'},
            {value:'rect',label:'rectified'},
            {value:'compare',label:'compare methods'},
          ]}/>
          {view !== 'compare' && view !== 'raw' && (
            <Seg value={method} onChange={setMethod} options={[
              {value:'remap',label:'remap'},
              {value:'undistort',label:'undistort'},
            ]}/>
          )}
          <Chk checked={showBoard} onChange={setShowBoard}>board</Chk>
          <Chk checked={showResid} onChange={setShowResid}>residuals</Chk>
          <Chk checked={liveDetect} onChange={setLiveDetect}>detect live</Chk>
          <div className="spacer"/>
          <div className="read">
            {streamInfo?.open && (
              <>{streamInfo.width}×{streamInfo.height} · <b>{streamInfo.capture_fps?.toFixed(1) ?? '—'}</b> fps · </>
            )}
            {result?.ok ? <>rms <b>{result.rms.toFixed(3)}</b> px</> : <>no calibration yet</>}
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
              rectifiedCell('remap', 'rectified · initUndistortRectifyMap + remap'),
              rectifiedCell('undistort', 'rectified · cv2.fisheye.undistortImage'),
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
        <div className="rail-header"><span>Results</span>
          <span className="mono" style={{color: result?.ok ? (rms < 0.5 ? 'var(--ok)' : 'var(--warn)') : 'var(--text-4)'}}>
            {result?.ok ? `● ${rms.toFixed(2)} px` : busy ? '● solving' : '○ idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <ErrorPanel rms={rms} frames={sparkData} histData={histData}/>
          <Section title="K (fisheye)">
            <Matrix m={K44}/>
          </Section>
          <Section title="Distortion (k₁…k₄)" hint={model}>
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
            cost={result?.final_cost ?? 0}
            cond={0}
            algo="cv2.fisheye · Levenberg-Marquardt"/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoad}>↓ load</button>
          <button className="btn primary" style={{flex:1}} onClick={onSave} disabled={!result?.ok}>↑ save</button>
        </div>
      </div>
    </div>
  );
}
