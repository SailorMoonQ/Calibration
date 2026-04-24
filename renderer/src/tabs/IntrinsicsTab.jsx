import React, { useState, useMemo, useEffect } from 'react';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import { CameraView, ChessboardOverlay, ResidualVectors, ErrorHeatmap } from '../components/viewport.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { LiveDetectedFrame } from '../components/LiveDetectedFrame.jsx';
import {
  FrameStrip, ErrorPanel, SourcePanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
} from '../components/panels.jsx';
import { genFrames, genResiduals, gridCells } from '../lib/mock.js';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

export function IntrinsicsTab() {
  const [board, setBoard] = useState({ type: 'chess', cols: 9, rows: 6, sq: 0.025 });
  const [live, setLive] = useState(true);
  const [device, setDevice] = useState('/dev/video0 · Basler acA1920');
  const [bagPath, setBagPath] = useState('~/datasets/2026-04-18_cam0.mcap');
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

  // When nothing real is loaded, fall back to the visual mock so the UI stays populated.
  const mockFrames = useMemo(() => genFrames(18, 0.26), []);
  const mockResiduals = useMemo(() => genResiduals(), []);

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

  const realFrames = useMemo(() => {
    if (!datasetFiles.length) return null;
    return datasetFiles.map((p, i) => ({
      id: i + 1,
      err: errByPath?.get(p) ?? 0,
      tx: 0, ty: 0, rot: 0,
    }));
  }, [datasetFiles, errByPath]);

  const frames = realFrames ?? mockFrames;
  const [selectedFrame, setSelected] = useState(4);

  const sparkData = useMemo(() => frames.map(f => f.err), [frames]);
  const histData = useMemo(() => {
    if (result?.per_frame_err?.length) return result.per_frame_err;
    return mockResiduals.map(r => Math.hypot(r.ex, r.ey));
  }, [result, mockResiduals]);

  const rms = result?.ok ? result.rms : 0.284;
  const Kraw = result?.K;
  const K = Kraw
    ? [[...Kraw[0], 0], [...Kraw[1], 0], [...Kraw[2], 0], [0, 0, 0, 1]]
    : [[1178.34, 0, 958.12, 0], [0, 1176.90, 598.44, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const D = result?.D ?? [-0.28431, 0.09412, -0.00030, 0.00107, -0.01820];

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

  const onSaveYaml = async () => {
    if (!result?.ok) { setStatus('nothing to save — run calibration first'); return; }
    const p = await pickSaveFile({ defaultPath: 'intrinsics.yaml' });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'intrinsics',
        result, board: boardPayload(), dataset_path: datasetPath || null,
      });
      setStatus(`saved → ${p}`);
    } catch (e) { setStatus(`save failed: ${e.message}`); }
  };

  const onLoadYaml = async () => {
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

  const vpW = 900, vpH = 560;
  const pp = K && K[0] && K[0][2] ? [K[0][2] * (vpW / 1920), K[1][2] * (vpH / 1200)] : [vpW * 0.505, vpH * 0.48];
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
            onSnap={onSnap} coverage={78}
            coverageCells={gridCells(40, [0,1,2,3,5,6,8,9,10,11,13,14,16,17,18,19,21,22,25,26,28,29,30,33,34,36,38])}/>
        </div>
        <SolverButton onSolve={onRun} busy={busy}/>
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
          <div className="read">frame <b>#{selectedFrame.toString().padStart(2,'0')}</b> · 1920×1200 · <b>{converged ? 'calibrated' : '30.1 fps'}</b></div>
        </div>
        <FrameStrip frames={frames} selected={selectedFrame} onSelect={(id) => { setSelected(id); setViewMode('frame'); }} coverage={78}/>
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
              <CameraView w={vpW} h={vpH} seed={selectedFrame} pp={pp} showGrid={true} label="cam0 · /camera/image_raw">
                {showBoard && <ChessboardOverlay cx={vpW*0.52} cy={vpH*0.48} cols={board.cols} rows={board.rows} tile={34} rotation={-0.18} skew={0.22} tilt={0.35} showOrigin={showOrigin}/>}
                {overlay === 'residuals' && <ResidualVectors corners={mockResiduals} scale={30}/>}
                {overlay === 'heatmap' && <ErrorHeatmap w={vpW} h={vpH}/>}
              </CameraView>
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
          <SolverPanel iters={result?.iterations || 24} cost={result?.final_cost || 0.0811} cond={182.4}/>
          <Section title="Per-axis uncertainty (1σ)" hint="TODO: from covariance">
            <KV items={[
              ['σ(fx)', '± 0.42 px', ''],
              ['σ(fy)', '± 0.39 px', ''],
              ['σ(cx)', '± 0.61 px', ''],
              ['σ(cy)', '± 0.58 px', ''],
              ['σ(k₁)', '± 6.1e-4', ''],
              ['σ(k₂)', '± 2.4e-3', ''],
            ]}/>
          </Section>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoadYaml}>↓ load yaml</button>
          <button className="btn primary" style={{flex:1}} onClick={onSaveYaml} disabled={!result?.ok}>↑ save yaml</button>
        </div>
      </div>
    </div>
  );
}
