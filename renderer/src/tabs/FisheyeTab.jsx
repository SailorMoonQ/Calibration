import React, { useState, useMemo, useEffect } from 'react';
import { Section, Seg, Chk, Field, Matrix } from '../components/primitives.jsx';
import { CameraView, ChessboardOverlay, ResidualVectors, DistortionGrid } from '../components/viewport.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { RectifiedFrame } from '../components/RectifiedFrame.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import {
  FrameStrip, ErrorPanel, SourcePanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
} from '../components/panels.jsx';
import { genFrames, genResiduals, gridCells } from '../lib/mock.js';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

export function FisheyeTab() {
  const [board, setBoard] = useState({ type: 'chess', cols: 9, rows: 6, sq: 0.030 });
  const [live, setLive] = useState(true);
  const [model, setModel] = useState('equidistant');
  const [view, setView] = useState('split');
  const [showGrid, setShowGrid] = useState(true);
  const [showBoard, setShowBoard] = useState(true);
  const [showResid, setShowResid] = useState(true);
  const [balance, setBalance] = useState(0.6);
  const [fovScale, setFovScale] = useState(1.0);
  const [device, setDevice] = useState('/camera/fisheye/image_raw · 1440×1080');
  const [bagPath, setBagPath] = useState('~/datasets/fisheye_run02.mcap');

  const [datasetPath, setDatasetPath] = useState('');
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const [devices, setDevices] = useState([]);
  const [liveDevice, setLiveDevice] = useState('');
  const [viewMode, setViewMode] = useState('live'); // 'live' | 'frame'

  const mockFrames = useMemo(() => genFrames(22, 0.42), []);
  const mockResiduals = useMemo(() => genResiduals(8, 5, 440, 280, 0.6), []);

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
      id: i + 1, err: errByPath?.get(p) ?? 0, tx: 0, ty: 0, rot: 0,
    }));
  }, [datasetFiles, errByPath]);

  const frames = realFrames ?? mockFrames;
  const [selected, setSelected] = useState(7);

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
      if (dir === datasetPath) {
        const files = await refreshDataset();
        if (files) { setSelected(files.length); setViewMode('frame'); }
      }
    } catch (e) { setStatus(`snap failed: ${e.message}`); }
  };

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

  const onSaveYaml = async () => {
    if (!result?.ok) { setStatus('nothing to save — run calibration first'); return; }
    const p = await pickSaveFile({ defaultPath: 'fisheye.yaml' });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'fisheye',
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
        K: d.K || null, D: d.D || [],
        image_size: d.image_size || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0,
        message: `loaded from ${p}`,
      });
      if (d.dataset_path && !datasetPath) setDatasetPath(d.dataset_path);
      setStatus(`loaded ← ${p}`);
    } catch (e) { setStatus(`load failed: ${e.message}`); }
  };

  const rms = result?.ok ? result.rms : 0.452;
  const Kraw = result?.K;
  const K44 = Kraw
    ? [[...Kraw[0], 0], [...Kraw[1], 0], [...Kraw[2], 0], [0,0,0,1]]
    : [[324.12, 0, 720.05, 0], [0, 324.06, 539.88, 0], [0, 0, 1, 0], [0,0,0,1]];
  const D = result?.D ?? [-0.04, 0.002, 0.00124, -0.00011];

  const histData = useMemo(() => result?.per_frame_err?.length
    ? result.per_frame_err
    : mockResiduals.map(r => Math.hypot(r.ex, r.ey)),
  [result, mockResiduals]);

  const W = 880, H = 560;
  const halfW = (W - 1) / 2;

  const selectedPath = datasetFiles[selected - 1];
  const canRectify = !!(result?.ok && Kraw && D && selectedPath);

  const rawCell = (
    <div className="vp-cell">
      <span className="vp-label">raw · distorted</span>
      {datasetFiles.length > 0 && selectedPath ? (
        <DetectedFrame
          path={selectedPath}
          board={board}
          showCorners={showBoard}
          showOrigin={true}
          overlay={showResid ? 'residuals' : 'none'}
          residuals={residualsByPath?.get(selectedPath)}/>
      ) : liveDevice ? (
        <LivePreview device={liveDevice}/>
      ) : (
        <CameraView w={halfW} h={H} fisheye seed={selected} pp={[halfW/2, H/2]} showGrid={showGrid} label="ω ≈ 195°">
          {showBoard && <ChessboardOverlay cx={halfW*0.45} cy={H*0.55} cols={board.cols} rows={board.rows} tile={22} rotation={0.1} skew={0.35} tilt={0.55} showOrigin={true}/>}
          {showResid && <ResidualVectors corners={mockResiduals} scale={22}/>}
          {showGrid && <DistortionGrid w={halfW} h={H} k1={-0.4} k2={0.02} color="rgba(120,190,255,0.35)"/>}
        </CameraView>
      )}
      <div className="vp-corner-read">
        <div>fx <b>{K44[0][0].toFixed(2)}</b>  fy <b>{K44[1][1].toFixed(2)}</b></div>
        <div>cx <b>{K44[0][2].toFixed(2)}</b>  cy <b>{K44[1][2].toFixed(2)}</b></div>
        <div>k₁ <b>{(D[0] ?? 0).toFixed(4)}</b>  k₂ <b>{(D[1] ?? 0).toFixed(4)}</b></div>
        <div>k₃ <b>{(D[2] ?? 0).toFixed(4)}</b>  k₄ <b>{(D[3] ?? 0).toFixed(4)}</b></div>
      </div>
    </div>
  );

  const rectCell = (
    <div className="vp-cell">
      <span className="vp-label">rectified · undistorted</span>
      {canRectify ? (
        <RectifiedFrame path={selectedPath} K={Kraw} D={D} balance={balance} fovScale={fovScale}/>
      ) : (
        <CameraView w={halfW} h={H} rectified seed={selected + 1} pp={[halfW/2, H/2]} showGrid={showGrid} label="K_new · balance 0.6">
          {showBoard && <ChessboardOverlay cx={halfW*0.5} cy={H*0.5} cols={board.cols} rows={board.rows} tile={30} rotation={0.05} skew={0.1} tilt={0.2} showOrigin={true}/>}
        </CameraView>
      )}
      <div className="vp-corner-read">
        <div>balance <b>{balance.toFixed(2)}</b></div>
        <div>fov_scale <b>{fovScale.toFixed(2)}</b></div>
      </div>
    </div>
  );

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header"><span>Fish-eye Intrinsics</span><span className="mono" style={{color:'var(--text-4)'}}>{result?.ok ? `rms ${result.rms.toFixed(2)}` : 'ω≈195°'}</span></div>
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
                <input type="range" min="50" max="200" value={Math.round(fovScale * 100)}
                       onChange={e => setFovScale(+e.target.value / 100)}/>
                <span className="mono">{fovScale.toFixed(2)}</span>
              </div>
            </Field>
          </Section>
          <CaptureControls live={live} onLive={setLive} autoCapture={true} onAuto={()=>{}}
            onSnap={onSnap}
            coverage={62} coverageCells={gridCells(40,[0,4,5,7,8,11,12,13,16,19,20,21,24,26,27,31,32,35,36,39])}/>
        </div>
        <SolverButton onSolve={onRun} busy={busy}/>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value={view} onChange={setView} options={[
            {value:'split',label:'split'},{value:'raw',label:'raw'},{value:'rect',label:'rectified'}
          ]}/>
          <Chk checked={showBoard} onChange={setShowBoard}>board</Chk>
          <Chk checked={showResid} onChange={setShowResid}>residuals</Chk>
          <Chk checked={showGrid} onChange={setShowGrid}>distortion grid</Chk>
          <div className="spacer"/>
          <div className="read">{result?.ok ? <>rms <b>{result.rms.toFixed(3)}</b> px</> : <>no calibration yet</>}</div>
        </div>
        <FrameStrip frames={frames} selected={selected} onSelect={(id) => { setSelected(id); setViewMode('frame'); }} coverage={62}/>
        <div className="vp-body vp-split" style={{ gridTemplateColumns: view === 'split' ? '1fr 1fr' : '1fr' }}>
          {view === 'split' && (<>{rawCell}{rectCell}</>)}
          {view === 'raw'  && rawCell}
          {view === 'rect' && rectCell}
        </div>
      </div>

      <div className="rail">
        <div className="rail-header"><span>Results</span>
          <span className="mono" style={{color: result?.ok ? (rms < 0.5 ? 'var(--ok)' : 'var(--warn)') : 'var(--text-4)'}}>
            {result?.ok ? `● ${rms.toFixed(2)} px` : busy ? '● solving' : '○ idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <ErrorPanel rms={rms} frames={frames.map(f => f.err)} histData={histData}/>
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
          <SolverPanel iters={result?.iterations || 30} cost={result?.final_cost || 0.2042} cond={412.7} algo="cv2.fisheye · Levenberg-Marquardt"/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoadYaml}>↓ load</button>
          <button className="btn primary" style={{flex:1}} onClick={onSaveYaml} disabled={!result?.ok}>↑ save yaml</button>
        </div>
      </div>
    </div>
  );
}
