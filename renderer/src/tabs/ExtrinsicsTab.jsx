import React, { useState, useMemo, useEffect } from 'react';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import { CameraView, ChessboardOverlay, ResidualVectors } from '../components/viewport.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import {
  FrameStrip, ErrorPanel, SourcePanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
} from '../components/panels.jsx';
import { genFrames, genResiduals, gridCells } from '../lib/mock.js';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

const basename = (p) => (p || '').split('/').pop();

// R as row-major 3x3 nested arrays → roll/pitch/yaw (ZYX Tait-Bryan) in degrees.
function rpyDeg(R) {
  const r = (v) => (v * 180) / Math.PI;
  const sy = Math.hypot(R[0][0], R[1][0]);
  if (sy < 1e-6) {
    return { roll: r(Math.atan2(-R[1][2], R[1][1])), pitch: r(Math.atan2(-R[2][0], sy)), yaw: 0 };
  }
  return {
    roll:  r(Math.atan2(R[2][1], R[2][2])),
    pitch: r(Math.atan2(-R[2][0], sy)),
    yaw:   r(Math.atan2(R[1][0], R[0][0])),
  };
}

export function ExtrinsicsTab() {
  const [board, setBoard] = useState({ type: 'chess', cols: 9, rows: 6, sq: 0.025 });
  const [live, setLive] = useState(true);
  const [device, setDevice] = useState('cam0 / cam1 paired');
  const [bagPath, setBagPath] = useState('~/datasets/stereo_pair.mcap');
  const [showResid, setShowResid] = useState(true);
  const [showBoard, setShowBoard] = useState(true);

  const [datasetPath0, setDatasetPath0] = useState('');
  const [datasetPath1, setDatasetPath1] = useState('');
  const [files0, setFiles0] = useState([]);
  const [files1, setFiles1] = useState([]);

  // intrinsics for each camera — loaded from YAML or can be edited by picking calibrated files.
  const [cam0Int, setCam0Int] = useState(null); // { K, D, image_size }
  const [cam1Int, setCam1Int] = useState(null);

  const [devices, setDevices] = useState([]);
  const [liveDev0, setLiveDev0] = useState('');
  const [liveDev1, setLiveDev1] = useState('');
  const [viewMode, setViewMode] = useState('live'); // 'live' | 'frame'

  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const mockFrames = useMemo(() => genFrames(22, 0.28), []);
  const mockResiduals = useMemo(() => genResiduals(9, 6, 450, 310, 0.25), []);

  // map cam0 path → pair
  const pairs = useMemo(() => {
    if (!files0.length || !files1.length) return [];
    const by1 = new Map(files1.map(p => [basename(p), p]));
    return files0
      .filter(p => by1.has(basename(p)))
      .map(p => ({ p0: p, p1: by1.get(basename(p)) }));
  }, [files0, files1]);

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
    if (!pairs.length) return null;
    return pairs.map((pr, i) => ({
      id: i + 1, err: errByPath?.get(pr.p0) ?? 0, tx: 0, ty: 0, rot: 0,
    }));
  }, [pairs, errByPath]);

  const frames = realFrames ?? mockFrames;
  const [selected, setSelected] = useState(1);

  useEffect(() => {
    let cancelled = false;
    api.listStreamDevices().then(r => {
      if (cancelled) return;
      const list = r.cameras || [];
      setDevices(list);
      if (list.length) {
        if (!liveDev0) setLiveDev0(list[0].device);
        if (!liveDev1 && list.length > 1) setLiveDev1(list[1].device);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const listFolder = (path, setter) => {
    if (!path) { setter([]); return; }
    api.listDataset(path).then(r => setter(r.files)).catch(() => setter([]));
  };
  useEffect(() => listFolder(datasetPath0, setFiles0), [datasetPath0]);
  useEffect(() => listFolder(datasetPath1, setFiles1), [datasetPath1]);

  const boardPayload = () => ({
    type: board.type, cols: board.cols, rows: board.rows,
    square: board.sq, marker: board.marker ?? null, dictionary: 'DICT_5X5_100',
  });

  const onPickFolder = async (which) => {
    const p = await pickFolder();
    if (!p) return;
    if (which === 0) setDatasetPath0(p); else setDatasetPath1(p);
  };

  const onSnapPair = async () => {
    if (!liveDev0 || !liveDev1) { setStatus('pick cam0 and cam1 devices first'); return; }
    let d0 = datasetPath0, d1 = datasetPath1;
    if (!d0) { d0 = await pickFolder(); if (!d0) return; setDatasetPath0(d0); }
    if (!d1) { d1 = await pickFolder(); if (!d1) return; setDatasetPath1(d1); }
    try {
      const r = await api.snapPair(liveDev0, liveDev1, d0, d1);
      setStatus(`pair → ${basename(r.path0)}`);
      const [r0, r1] = await Promise.all([api.listDataset(d0), api.listDataset(d1)]);
      setFiles0(r0.files); setFiles1(r1.files);
      setViewMode('frame');
      setSelected(r0.files.length);
    } catch (e) { setStatus(`snap failed: ${e.message}`); }
  };

  const loadIntrinsicsInto = async (setter, labelCam) => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      if (!d.K || !d.D) { setStatus(`${labelCam}: no K/D in yaml`); return; }
      setter({ K: d.K, D: d.D, image_size: d.image_size || null, path: p });
      setStatus(`${labelCam} intrinsics ← ${basename(p)}`);
    } catch (e) { setStatus(`${labelCam} load failed: ${e.message}`); }
  };

  const onRun = async () => {
    if (!datasetPath0 || !datasetPath1) { setStatus('pick both cam0 and cam1 dataset folders'); return; }
    if (!cam0Int || !cam1Int) { setStatus('load intrinsics YAML for both cameras first'); return; }
    if (!pairs.length) { setStatus('no filename-matched pairs across the two folders'); return; }
    setBusy(true); setStatus(`solving · ${pairs.length} pairs…`);
    try {
      const res = await api.calibrate('extrinsics', {
        board: boardPayload(),
        dataset_path_0: datasetPath0,
        dataset_path_1: datasetPath1,
        K0: cam0Int.K, D0: cam0Int.D,
        K1: cam1Int.K, D1: cam1Int.D,
      });
      setResult(res);
      setStatus(res.ok ? `rms ${res.rms.toFixed(4)} px · ${res.message}` : `failed: ${res.message}`);
    } catch (e) { setStatus(`error: ${e.message}`); } finally { setBusy(false); }
  };

  const onSaveYaml = async () => {
    if (!result?.ok) { setStatus('nothing to save — run calibration first'); return; }
    const p = await pickSaveFile({ defaultPath: 'extrinsics.yaml' });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'extrinsics',
        result, board: boardPayload(),
        dataset_path: `${datasetPath0} ⇆ ${datasetPath1}`,
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
        T: d.T || null,
        image_size: d.image_size || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0,
        message: `loaded from ${p}`,
      });
      setStatus(`loaded ← ${p}`);
    } catch (e) { setStatus(`load failed: ${e.message}`); }
  };

  const Tmat = result?.T ?? [
    [1, 0, 0, 0.12014],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const R = [[Tmat[0][0], Tmat[0][1], Tmat[0][2]],
             [Tmat[1][0], Tmat[1][1], Tmat[1][2]],
             [Tmat[2][0], Tmat[2][1], Tmat[2][2]]];
  const t = [Tmat[0][3], Tmat[1][3], Tmat[2][3]];
  const baselineMm = Math.hypot(t[0], t[1], t[2]) * 1000;
  const rpy = rpyDeg(R);

  const rms = result?.ok ? result.rms : 0.218;

  const vpW = 900, vpH = 620;
  const histData = useMemo(() => result?.per_frame_err?.length
    ? result.per_frame_err
    : mockResiduals.map(r => Math.hypot(r.ex, r.ey)),
  [result, mockResiduals]);

  const selectedPair = pairs[selected - 1];

  const leftCell = (
    <div className="vp-cell">
      <span className="vp-label">cam0 · left {liveDev0 ? `· ${liveDev0}` : ''}</span>
      {viewMode === 'live' && liveDev0 ? (
        <LivePreview device={liveDev0}/>
      ) : selectedPair ? (
        <DetectedFrame path={selectedPair.p0} board={board}
          showCorners={showBoard} showOrigin={true} overlay="none"/>
      ) : (
        <CameraView w={vpW/2} h={vpH} seed={selected}>
          <ChessboardOverlay cx={vpW/4*0.85} cy={vpH/2} cols={board.cols} rows={board.rows}
            tile={22} rotation={-0.15} skew={0.2} tilt={0.3} showOrigin={true}/>
        </CameraView>
      )}
    </div>
  );

  const rightCell = (
    <div className="vp-cell">
      <span className="vp-label">cam1 · right {liveDev1 ? `· ${liveDev1}` : ''}</span>
      {viewMode === 'live' && liveDev1 ? (
        <LivePreview device={liveDev1}/>
      ) : selectedPair ? (
        <DetectedFrame path={selectedPair.p1} board={board}
          showCorners={showBoard} showOrigin={true}
          overlay={showResid ? 'residuals' : 'none'}
          residuals={residualsByPath?.get(selectedPair.p0)}/>
      ) : (
        <CameraView w={vpW/2} h={vpH} seed={selected + 10}>
          <ChessboardOverlay cx={vpW/4*1.05} cy={vpH/2} cols={board.cols} rows={board.rows}
            tile={22} rotation={-0.12} skew={0.22} tilt={0.32} showOrigin={true}/>
          {showResid && <ResidualVectors corners={mockResiduals} scale={24}/>}
        </CameraView>
      )}
    </div>
  );

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header"><span>Extrinsics · cam↔cam</span>
          <span className="mono" style={{color:'var(--text-4)'}}>{pairs.length} pairs</span>
        </div>
        <div className="rail-scroll">
          <SourcePanel live={live} onLive={setLive} device={device} onDevice={setDevice}
            bagPath={bagPath} onBagPath={setBagPath}/>
          <Section title="Live cameras" hint="pair capture">
            <Field label="cam0">
              <select className="select" value={liveDev0} onChange={e => setLiveDev0(e.target.value)}>
                <option value="">— none —</option>
                {devices.map(d => <option key={d.device} value={d.device}>{d.label}</option>)}
              </select>
            </Field>
            <Field label="cam1">
              <select className="select" value={liveDev1} onChange={e => setLiveDev1(e.target.value)}>
                <option value="">— none —</option>
                {devices.map(d => <option key={d.device} value={d.device}>{d.label}</option>)}
              </select>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={() => setViewMode('live')}>👁 live</button>
              <button className="btn ghost" onClick={() => api.listStreamDevices().then(r => setDevices(r.cameras || []))}>↻ rescan</button>
            </div>
          </Section>
          <Section title="Datasets" hint="matched by filename">
            <Field label="cam0 folder">
              <input className="input" value={datasetPath0} placeholder="/path/to/cam0/"
                onChange={e => setDatasetPath0(e.target.value)}/>
            </Field>
            <Field label="cam1 folder">
              <input className="input" value={datasetPath1} placeholder="/path/to/cam1/"
                onChange={e => setDatasetPath1(e.target.value)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={() => onPickFolder(0)}>📁 pick cam0</button>
              <button className="btn" onClick={() => onPickFolder(1)}>📁 pick cam1</button>
            </div>
            <div className="mono" style={{fontSize:10.5, color:'var(--text-3)'}}>
              {files0.length}/{files1.length} files · {pairs.length} paired
            </div>
          </Section>
          <Section title="Intrinsics" hint="required · load cal YAML">
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={() => loadIntrinsicsInto(setCam0Int, 'cam0')}>
                ↓ cam0 {cam0Int ? '✓' : ''}
              </button>
              <button className="btn" onClick={() => loadIntrinsicsInto(setCam1Int, 'cam1')}>
                ↓ cam1 {cam1Int ? '✓' : ''}
              </button>
            </div>
            {(cam0Int || cam1Int) && (
              <div className="mono" style={{fontSize:10.5, color:'var(--text-3)', marginTop:2}}>
                {cam0Int ? `cam0: ${basename(cam0Int.path)}` : 'cam0: —'}<br/>
                {cam1Int ? `cam1: ${basename(cam1Int.path)}` : 'cam1: —'}
              </div>
            )}
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title="Solver">
            <Chk checked={true} onChange={()=>{}}>fix intrinsics (recommended)</Chk>
            <Chk checked={true} onChange={()=>{}}>require both cams detect board</Chk>
          </Section>
          <CaptureControls live={live} onLive={setLive} autoCapture={true} onAuto={()=>{}}
            onSnap={onSnapPair}
            coverage={Math.min(100, Math.round((pairs.length / 30) * 100))}
            coverageCells={gridCells(40, [])}/>
          {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', padding: '0 2px' }}>{status}</div>}
        </div>
        <SolverButton onSolve={onRun} busy={busy}/>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value={viewMode} onChange={setViewMode} options={[
            {value:'live',label:'live'},{value:'frame',label:'pair'}
          ]}/>
          <Chk checked={showBoard} onChange={setShowBoard}>board</Chk>
          <Chk checked={showResid} onChange={setShowResid}>residuals</Chk>
          <div className="spacer"/>
          <div className="read">
            {result?.ok
              ? <>baseline <b>{baselineMm.toFixed(2)} mm</b> · rms <b>{result.rms.toFixed(3)}</b> px</>
              : <>no calibration yet</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selected}
          onSelect={(id) => { setSelected(id); setViewMode('frame'); }}
          coverage={Math.min(100, Math.round((pairs.length / 30) * 100))}/>
        <div className="vp-body" style={{ gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--view-border)' }}>
          {leftCell}
          {rightCell}
        </div>
      </div>

      <div className="rail">
        <div className="rail-header">
          <span>Results · T_cam0_cam1</span>
          <span className="mono" style={{color: result?.ok ? 'var(--ok)' : 'var(--text-4)'}}>
            {result?.ok ? `● ${rms.toFixed(2)} px` : busy ? '● solving' : '○ idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <Section title="Rigid transform" hint="cam0 → cam1">
            <Matrix m={Tmat}/>
            <KV items={[
              ['baseline', `${baselineMm.toFixed(2)} mm`, 'pos'],
              ['roll',  `${rpy.roll.toFixed(3)}°`, ''],
              ['pitch', `${rpy.pitch.toFixed(3)}°`, ''],
              ['yaw',   `${rpy.yaw.toFixed(3)}°`, ''],
              ['t_x',   `${(t[0]*1000).toFixed(2)} mm`, ''],
              ['t_y',   `${(t[1]*1000).toFixed(2)} mm`, ''],
              ['t_z',   `${(t[2]*1000).toFixed(2)} mm`, ''],
            ]}/>
          </Section>
          <ErrorPanel rms={rms} frames={frames.map(f => f.err)} histData={histData}/>
          <SolverPanel iters={result?.iterations || 60} cost={result?.final_cost || 0.0476} cond={98.4}
            algo="cv2.stereoCalibrate · CALIB_FIX_INTRINSIC"/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoadYaml}>↓ load</button>
          <button className="btn primary" style={{flex:1}} onClick={onSaveYaml} disabled={!result?.ok}>↑ save yaml</button>
        </div>
      </div>
    </div>
  );
}
