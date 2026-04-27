import React, { useState, useMemo, useEffect } from 'react';
import { Section, Seg, Chk, Field, Matrix } from '../components/primitives.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { LiveDetectedFrame } from '../components/LiveDetectedFrame.jsx';
import {
  FrameStrip, ErrorPanel, SourcePanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
} from '../components/panels.jsx';
import { computeCoverage } from '../lib/coverage.js';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

const ZERO_K = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]];

export function IntrinsicsTab() {
  const [board, setBoard] = useState({ type: 'chess', cols: 11, rows: 8, sq: 0.045 });
  const [live, setLive] = useState(true);
  const [device, setDevice] = useState('/dev/video0 · Basler acA1920');
  const [bagPath, setBagPath] = useState('');
  const [autoCapture, setAuto] = useState(true);
  const [overlay, setOverlay] = useState('residuals');
  const [showBoard, setShowBoard] = useState(true);
  const [showOrigin, setShowOrigin] = useState(true);
  const [model, setModel] = useState('pinhole-k3');

  const [datasetPath, setDatasetPath] = useState('');
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const [devices, setDevices] = useState([]);
  const [liveDevice, setLiveDevice] = useState('');
  const [viewMode, setViewMode] = useState('live'); // 'live' | 'frame'
  const [liveDetect, setLiveDetect] = useState(false);

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

  const coverage = useMemo(
    () => computeCoverage(result?.per_frame_residuals, result?.image_size),
    [result],
  );

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

  useEffect(() => {
    let cancelled = false;
    api.listStreamDevices().then(r => {
      if (cancelled) return;
      const list = r.cameras || [];
      setDevices(list);
      if (list.length && !liveDevice) setLiveDevice(list[0].device);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!datasetPath) return;
    let cancelled = false;
    api.listDataset(datasetPath).then(r => {
      if (cancelled) return;
      setDatasetFiles(r.files);
      setStatus(`${r.count} images in dataset`);
      setSelected(1);
      setResult(null);
    }).catch(e => !cancelled && setStatus(`listing failed: ${e.message}`));
    return () => { cancelled = true; };
  }, [datasetPath]);

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
      setStatus(`snapped → ${r.path.split('/').pop()}`);
      // When we just snapped into the active datasetPath, listing is stale — refresh.
      if (dir === datasetPath) {
        const files = await refreshDataset();
        if (files) { setSelected(files.length); setViewMode('frame'); }
      }
    } catch (e) { setStatus(`snap failed: ${e.message}`); }
  };

  const boardPayload = () => ({
    type: board.type,
    cols: board.cols,
    rows: board.rows,
    square: board.sq,
    marker: board.marker ?? null,
    dictionary: 'DICT_5X5_100',
  });

  const onSave = async () => {
    if (!result?.ok) { setStatus('nothing to save — run calibration first'); return; }
    const p = await pickSaveFile({ defaultPath: 'intrinsics.yaml' });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'intrinsics',
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
      setResult({
        ok: true,
        rms: d.rms ?? 0,
        K: d.K || null,
        D: d.D || [],
        image_size: d.image_size || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [],
        detected_paths: [],
        iterations: 0, final_cost: 0,
        message: `loaded from ${p}`,
      });
      if (d.dataset_path && !datasetPath) setDatasetPath(d.dataset_path);
      setStatus(`loaded ← ${p}`);
    } catch (e) { setStatus(`load failed: ${e.message}`); }
  };

  const onRun = async () => {
    if (!datasetPath) {
      setStatus('pick a dataset folder first');
      return;
    }
    setBusy(true);
    setStatus('detecting + solving…');
    try {
      const res = await api.calibrate('intrinsics', {
        board: boardPayload(),
        model,
        dataset_path: datasetPath,
      });
      setResult(res);
      setStatus(res.ok
        ? `rms ${res.rms.toFixed(4)} px · ${res.message}`
        : `failed: ${res.message}`);
    } catch (e) {
      setStatus(`error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const converged = result?.ok ?? false;

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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <button className="btn" onClick={onPickFolder}>📁 pick folder</button>
              <button className="btn ghost" onClick={() => { setDatasetPath(''); setDatasetFiles([]); setResult(null); setStatus(''); }}>clear</button>
            </div>
            {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>{status}</div>}
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title="Model" hint={model}>
            <Field label="projection">
              <Seg value={model} onChange={setModel} full options={[{value:'pinhole-k3',label:'k3'},{value:'pinhole-k5',label:'k5'},{value:'pinhole-rt',label:'rational'}]}/>
            </Field>
            <Chk checked={true} onChange={()=>{}}>estimate skew</Chk>
            <Chk checked={false} onChange={()=>{}}>fix aspect ratio (fx = fy)</Chk>
            <Chk checked={true} onChange={()=>{}}>bundle adjust extrinsics</Chk>
            <Chk checked={false} onChange={()=>{}}>use robust loss (Huber)</Chk>
          </Section>
          <CaptureControls live={live} onLive={setLive} autoCapture={autoCapture} onAuto={setAuto}
            onSnap={onSnap} coverage={coverage.percent}
            coverageCells={coverage.cells}/>
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
          <Seg value={overlay} onChange={setOverlay} options={[
            {value:'none',label:'raw'},{value:'residuals',label:'residuals'},{value:'heatmap',label:'heatmap'}
          ]}/>
          <Chk checked={showBoard} onChange={setShowBoard}>board</Chk>
          <Chk checked={showOrigin} onChange={setShowOrigin}>origin</Chk>
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
        <div className="vp-body">
          <div className="vp-cell">
            {(viewMode === 'live' || datasetFiles.length === 0) && liveDevice ? (
              <>
                <span className="vp-label">live · {liveDevice}{liveDetect ? ' · detect' : ''}</span>
                {liveDetect
                  ? <LiveDetectedFrame device={liveDevice} board={board}
                       showCorners={showBoard} showOrigin={showOrigin}/>
                  : <LivePreview device={liveDevice}/>}
              </>
            ) : datasetFiles.length > 0 ? (
              <>
                <span className="vp-label">{datasetFiles[selectedFrame - 1]?.split('/').pop() ?? ''}</span>
                <DetectedFrame
                  path={datasetFiles[selectedFrame - 1]}
                  board={board}
                  showCorners={showBoard}
                  showOrigin={showOrigin}
                  overlay={overlay}
                  residuals={residualsByPath?.get(datasetFiles[selectedFrame - 1])}/>
              </>
            ) : (
              <div style={{
                display:'flex', alignItems:'center', justifyContent:'center',
                width:'100%', height:'100%', color:'var(--view-text-2)',
                fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign:'center',
              }}>connect a camera or load a dataset</div>
            )}
            <div className="vp-corner-read">
              <div>fx <b>{K[0][0].toFixed(2)}</b>  fy <b>{K[1][1].toFixed(2)}</b></div>
              <div>cx <b>{K[0][2].toFixed(2)}</b>  cy <b>{K[1][2].toFixed(2)}</b></div>
              <div>k₁ <b>{(D[0] ?? 0).toFixed(3)}</b>  k₂ <b>{(D[1] ?? 0).toFixed(3)}</b></div>
              <div>p₁ <b>{(D[2] ?? 0).toFixed(4)}</b> p₂ <b>{(D[3] ?? 0).toFixed(4)}</b></div>
            </div>
            <div className="vp-scale"><span className="bar"/> <span>100 px</span></div>
          </div>
        </div>
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
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoad}>↓ load</button>
          <button className="btn primary" style={{flex:1}} onClick={onSave} disabled={!result?.ok}>↑ save</button>
        </div>
      </div>
    </div>
  );
}
