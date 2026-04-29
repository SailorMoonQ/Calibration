import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import { CameraView, ChessboardOverlay } from '../components/viewport.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { Ros2TopicPicker } from '../components/Ros2TopicPicker.jsx';
import { useCameraSource, CameraSourcePanel } from '../components/CameraSource.jsx';
import {
  Scene3D, Frustum3D, HMD3D, Controller3D, Traj3D, Chessboard3D, RigidLink3D,
} from '../components/scene3d.jsx';
import {
  FrameStrip, ErrorPanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
} from '../components/panels.jsx';
import { makeT, applyT, composeT } from '../lib/math3d.js';
import { genFrames, gridCells } from '../lib/mock.js';
import { api, pickFolder, pickSaveFile, pickOpenFile, posesWsUrl } from '../api/client.js';

const basename = (p) => (p || '').split('/').pop();

const TRACKER_SOURCES = [
  { value: 'oculus',  label: 'Oculus Reader' },
  { value: 'ros2',    label: 'ROS2 topic' },
  { value: 'steamvr', label: 'SteamVR' },
  { value: 'file',    label: 'JSON file' },
];

export function HandEyeTab() {
  const [kind, setKind] = useState('hmd');
  const isHMD = kind === 'hmd';
  const trackerLabel = isHMD ? 'HMD' : 'controller';
  const xmatLabel = isHMD ? 'T_hmd_cam' : 'T_ctrl_cam';
  const TrackerGlyph = isHMD ? HMD3D : Controller3D;
  const trackerColor = isHMD ? '#6fbcff' : '#b78cff';

  const [board, setBoard] = useState({ type: 'charuco', cols: 9, rows: 6, sq: 0.025, marker: 0.018 });
  const [method, setMethod] = useState('park');
  const [showTraj, setShowTraj] = useState(true);
  const [showBoard, setShowBoard] = useState(true);

  const [trackerSource, setTrackerSource] = useState('file');
  const [oculusDevice, setOculusDevice] = useState('');
  const [trackerRos2Topic, setTrackerRos2Topic] = useState('');
  const [steamvrSerial, setSteamvrSerial] = useState('');

  const [datasetPath, setDatasetPath] = useState('');
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [posesPath, setPosesPath] = useState('');
  const [camInt, setCamInt] = useState(null); // { K, D, path }

  const [viewMode, setViewMode] = useState('live');

  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  // Live tracker stream (used to attach pose to each captured image).
  const [connected, setConnected] = useState(false);
  const [poseHz, setPoseHz] = useState(0);
  const [poseStaleMs, setPoseStaleMs] = useState(null);
  const wsRef = useRef(null);
  const latestPoseRef = useRef(null);  // {ts, T, device}
  const poseTickWindowRef = useRef([]); // last ~1s of wall_ts for fps calc

  const trackerDeviceKey = () => {
    if (trackerSource === 'oculus')  return oculusDevice || (kind === 'ctrl' ? 'controller_R' : 'hmd');
    if (trackerSource === 'steamvr') return steamvrSerial || (kind === 'ctrl' ? 'controller_R' : 'tracker_0');
    return null;
  };

  const onConnectTracker = useCallback(async () => {
    if (wsRef.current) return;
    if (trackerSource === 'file' || trackerSource === 'ros2') {
      setStatus(`${trackerSource} not supported as a live recorder this iteration`);
      return;
    }
    const device = trackerDeviceKey();
    if (!device) { setStatus('pick a tracker device first'); return; }
    setStatus('connecting tracker…');
    try {
      const url = await posesWsUrl({ fps: 30, sources: [trackerSource] });
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); setStatus(`tracker ws open · ${trackerSource}`); };
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        latestPoseRef.current = null;
        setPoseStaleMs(null);
        setPoseHz(0);
      };
      ws.onerror = () => setStatus('tracker ws error');
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'error') { setStatus(`${m.source} error: ${m.message}`); return; }
        if (m.type !== 'sample' || !m.poses) return;
        const T = m.poses[device];
        if (!T) return;
        const ts = (typeof m.wall_ts === 'number') ? m.wall_ts : (Date.now() / 1000);
        latestPoseRef.current = { ts, T, device };
        const win = poseTickWindowRef.current;
        win.push(ts);
        const cutoff = ts - 1.0;
        while (win.length && win[0] < cutoff) win.shift();
      };
    } catch (e) { setStatus(`connect failed: ${e.message}`); }
  }, [trackerSource, oculusDevice, steamvrSerial, kind]);

  const onDisconnectTracker = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    try { ws.close(); } catch {}
    wsRef.current = null;
    setConnected(false);
    latestPoseRef.current = null;
    setPoseStaleMs(null);
    setPoseHz(0);
  }, []);

  // Refresh staleness/fps readout twice a second from the ref-held buffer.
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => {
      const lp = latestPoseRef.current;
      if (lp) setPoseStaleMs(Math.max(0, Math.round((Date.now() / 1000 - lp.ts) * 1000)));
      setPoseHz(poseTickWindowRef.current.length);
    }, 500);
    return () => clearInterval(id);
  }, [connected]);

  // Always disconnect on unmount.
  useEffect(() => () => onDisconnectTracker(), [onDisconnectTracker]);

  const [autoCapture, setAutoCapture] = useState(false);
  const [autoCaptureRate, setAutoCaptureRate] = useState(0.5);  // seconds between snaps
  const [recordedCount, setRecordedCount] = useState(0);

  // Hold the latest onSnap in a ref so the auto-capture timer always calls
  // through to the up-to-date closure without resubscribing on every state tick.
  const onSnapRef = useRef(null);

  const mockFrames = useMemo(() => genFrames(30, 0.38), []);
  const mockPoses = useMemo(() => Array.from({ length: 56 }, (_, i) => {
    const t = i / 56;
    const r = 0.15;
    const x = Math.sin(t * Math.PI * 2) * r;
    const y = 0.05 + Math.sin(t * Math.PI * 4) * 0.04;
    const z = Math.cos(t * Math.PI * 2) * r * 0.6 + 0.05;
    return makeT(0.3 * Math.sin(t*6), -Math.PI/2 + t*0.8, 0.25 * Math.cos(t*5), x, y, z);
  }), []);

  const errByPath = useMemo(() => {
    if (!result?.ok) return null;
    const m = new Map();
    (result.detected_paths || []).forEach((name, i) => m.set(name, result.per_frame_err?.[i] ?? 0));
    return m;
  }, [result]);

  const realFrames = useMemo(() => {
    if (!datasetFiles.length) return null;
    return datasetFiles.map((p, i) => ({
      id: i + 1, err: errByPath?.get(basename(p)) ?? 0, tx: 0, ty: 0, rot: 0,
    }));
  }, [datasetFiles, errByPath]);

  const frames = realFrames ?? mockFrames;
  const [selected, setSelected] = useState(1);

  const cam = useCameraSource({
    pollEnabled: viewMode === 'live' || datasetFiles.length === 0,
  });
  const { liveDevice } = cam;

  useEffect(() => {
    if (!datasetPath) { setDatasetFiles([]); return; }
    let cancelled = false;
    api.listDataset(datasetPath).then(r => {
      if (cancelled) return;
      setDatasetFiles(r.files);
      setSelected(1);
      setStatus(`${r.count} images`);
    }).catch(e => !cancelled && setStatus(`listing failed: ${e.message}`));
    return () => { cancelled = true; };
  }, [datasetPath]);

  const boardPayload = () => ({
    type: board.type, cols: board.cols, rows: board.rows,
    square: board.sq, marker: board.marker ?? null, dictionary: 'DICT_5X5_100',
  });

  const onPickDataset = async () => {
    const p = await pickFolder(datasetPath || undefined);
    if (p) setDatasetPath(p);
  };

  const onPickPoses = async () => {
    const p = await pickOpenFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (p) { setPosesPath(p); setStatus(`poses ← ${basename(p)}`); }
  };

  const onLoadIntrinsics = async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      if (!d.K || !d.D) { setStatus(`${basename(p)}: no K/D in yaml`); return; }
      setCamInt({ K: d.K, D: d.D, path: p });
      setStatus(`intrinsics ← ${basename(p)}`);
    } catch (e) { setStatus(`intrinsics load failed: ${e.message}`); }
  };

  const onSnap = async () => {
    let dir = datasetPath;
    if (!dir) {
      const picked = await pickFolder();
      if (!picked) { setStatus('pick a session folder before snapping'); return; }
      setDatasetPath(picked); dir = picked;
    }
    if (!liveDevice) { setStatus('pick a camera first'); return; }

    // Read pose snapshot BEFORE the snap so time skew is bounded by image-write
    // latency, not the snap RPC round trip. lp may be null (image-only snap).
    const lp = connected ? latestPoseRef.current : null;
    if (connected) {
      if (!lp) { setStatus('no pose yet — wait for tracker stream'); return; }
      const ageMs = Math.round((Date.now() / 1000 - lp.ts) * 1000);
      if (ageMs > 200) { setStatus(`pose stale (Δt = ${ageMs} ms) — check tracker`); return; }
    }

    let imagePath;
    try {
      const r = await api.snap(liveDevice, dir);
      imagePath = r.path;
    } catch (e) { setStatus(`snap failed: ${e.message}`); return; }

    const fname = basename(imagePath);

    if (lp) {
      const posesPathLocal = `${dir}/poses.json`;
      const meta = { tracker_source: trackerSource, device: lp.device, kind };
      let appended = false;
      for (let attempt = 0; attempt < 2 && !appended; attempt++) {
        try {
          const r = await api.appendHandeyePose({
            poses_path: posesPathLocal, basename: fname, T: lp.T, ts: lp.ts, meta,
          });
          appended = true;
          setRecordedCount(r.n);
          if (posesPath !== posesPathLocal) setPosesPath(posesPathLocal);
        } catch (e) {
          if (attempt === 1) {
            setStatus(`image saved, pose append failed: ${e.message}`);
          }
        }
      }
      if (appended) setStatus(`snapped+pose → ${fname}`);
    } else {
      setStatus(`snap (image only — connect tracker for pose) → ${fname}`);
    }

    if (dir === datasetPath) {
      const ls = await api.listDataset(datasetPath);
      setDatasetFiles(ls.files);
      setSelected(ls.files.length);
      setViewMode('frame');
    }
  };
  onSnapRef.current = onSnap;

  // Auto-capture: drive paired (image, pose) snaps on a timer.
  useEffect(() => {
    if (!autoCapture) return;
    const period = Math.max(50, Math.round(autoCaptureRate * 1000));
    const id = setInterval(() => { onSnapRef.current?.(); }, period);
    return () => clearInterval(id);
  }, [autoCapture, autoCaptureRate]);

  const onRun = async () => {
    if (!datasetPath) { setStatus('pick a dataset folder'); return; }
    if (trackerSource !== 'file') {
      setStatus(`${trackerSource} live source not yet wired — pick JSON file source`);
      return;
    }
    if (!posesPath) { setStatus('pick the tracker-poses JSON'); return; }
    if (!camInt) { setStatus('load camera intrinsics YAML'); return; }
    setBusy(true); setStatus('solving AX=XB…');
    try {
      const res = await api.calibrate('handeye', {
        method, kind,
        board: boardPayload(),
        dataset_path: datasetPath,
        poses_path: posesPath,
        K: camInt.K, D: camInt.D,
      });
      setResult(res);
      setStatus(res.ok
        ? `rot ${res.rms.toFixed(3)}° · trans ${res.final_cost.toFixed(2)} mm · ${res.message}`
        : `failed: ${res.message}`);
    } catch (e) { setStatus(`error: ${e.message}`); } finally { setBusy(false); }
  };

  const onSaveYaml = async () => {
    if (!result?.ok) { setStatus('nothing to save — run calibration first'); return; }
    const p = await pickSaveFile({ defaultPath: `handeye_${kind}.yaml` });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'handeye',
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
        ok: true, rms: d.rms ?? 0,
        K: d.K || null, D: d.D || [], T: d.T || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0, message: `loaded from ${p}`,
      });
      setStatus(`loaded ← ${p}`);
    } catch (e) { setStatus(`load failed: ${e.message}`); }
  };

  const Tmat = result?.T ?? [
    [1, 0, 0, 0.024],
    [0, 1, 0, -0.012],
    [0, 0, 1, 0.041],
    [0, 0, 0, 1],
  ];
  const tVec = [Tmat[0][3], Tmat[1][3], Tmat[2][3]];
  const tMm = tVec.map(v => v * 1000);
  const tNorm = Math.hypot(...tMm);

  const rpyDeg = (() => {
    const R = [[Tmat[0][0], Tmat[0][1], Tmat[0][2]],
               [Tmat[1][0], Tmat[1][1], Tmat[1][2]],
               [Tmat[2][0], Tmat[2][1], Tmat[2][2]]];
    const r = (v) => (v * 180) / Math.PI;
    const sy = Math.hypot(R[0][0], R[1][0]);
    if (sy < 1e-6) return [r(Math.atan2(-R[1][2], R[1][1])), r(Math.atan2(-R[2][0], sy)), 0];
    return [r(Math.atan2(R[2][1], R[2][2])), r(Math.atan2(-R[2][0], sy)), r(Math.atan2(R[1][0], R[0][0]))];
  })();

  const histData = useMemo(() => result?.per_frame_err?.length ? result.per_frame_err
    : Array.from({ length: 22 }, (_, i) => 0.5 + Math.sin(i) * 0.3 + 0.3),
  [result]);

  const rotRms = result?.ok ? result.rms : 0.382;
  const transRms = result?.ok ? result.final_cost : 1.42;
  const vpW = 900, vpH = 620;

  const selectedPath = datasetFiles[selected - 1];

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>Hand-Eye · cam ↔ {trackerLabel}</span>
          <span className="mono" style={{color:'var(--text-4)'}}>AX=XB</span>
        </div>
        <div className="rail-scroll">
          <CameraSourcePanel source={cam} onLivePreview={() => setViewMode('live')}/>
          <Section title="Dataset" hint={datasetFiles.length ? `${datasetFiles.length} images` : 'not loaded'}>
            <Field label="folder">
              <input className="input" value={datasetPath} placeholder="/path/to/frames/"
                onChange={e => setDatasetPath(e.target.value)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={onPickDataset}>📁 pick</button>
              <button className="btn ghost" onClick={() => { setDatasetPath(''); setDatasetFiles([]); }}>clear</button>
            </div>
            {recordedCount > 0 && (
              <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>
                poses.json · {recordedCount} entries
              </div>
            )}
          </Section>
          <Section
            title="Tracker source"
            hint={
              trackerSource === 'file'    ? (posesPath ? basename(posesPath) : 'pick json') :
              trackerSource === 'oculus'  ? (oculusDevice || 'pick device') :
              trackerSource === 'ros2'    ? (trackerRos2Topic || 'pick topic') :
                                            (steamvrSerial || 'pick tracker')
            }
            right={connected ? null : <Seg value={trackerSource} onChange={setTrackerSource} options={
              TRACKER_SOURCES.map(s => ({ value: s.value, label: s.label.split(' ')[0].toLowerCase() }))
            }/>}
          >
            <Field label="body">
              <select className="select" value={kind} disabled={connected}
                onChange={e => setKind(e.target.value)}>
                <option value="hmd">HMD</option>
                <option value="ctrl">controller</option>
              </select>
            </Field>
            {trackerSource === 'oculus' && (
              <>
                <Field label="device">
                  <select className="select" value={oculusDevice} disabled={connected}
                    onChange={e => setOculusDevice(e.target.value)}>
                    <option value="">— none —</option>
                    <option value="quest3">Quest 3</option>
                    <option value="quest2">Quest 2</option>
                    <option value="questpro">Quest Pro</option>
                  </select>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                  via Oculus Reader · adb pose stream
                </div>
              </>
            )}
            {trackerSource === 'ros2' && (
              <Ros2TopicPicker
                topic={trackerRos2Topic}
                onTopic={setTrackerRos2Topic}/>
            )}
            {trackerSource === 'steamvr' && (
              <>
                <Field label="serial">
                  <input className="input" value={steamvrSerial} placeholder="LHR-XXXXXXXX" disabled={connected}
                    onChange={e => setSteamvrSerial(e.target.value)}/>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                  via SteamVR pose publisher
                </div>
              </>
            )}
            {trackerSource === 'file' && (
              <>
                <Field label="file">
                  <input className="input" value={posesPath} placeholder="basename → 4x4 matrix"
                    onChange={e => setPosesPath(e.target.value)}/>
                </Field>
                <button className="btn" onClick={onPickPoses}>📁 pick json</button>
              </>
            )}
            {(trackerSource === 'oculus' || trackerSource === 'steamvr') && (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  {!connected
                    ? <button className="btn primary" onClick={onConnectTracker}>⚡ connect</button>
                    : <button className="btn ghost" onClick={onDisconnectTracker}>⨯ disconnect</button>}
                </div>
                {connected && (
                  <div className="mono" style={{ fontSize: 10.5,
                    color: (poseStaleMs ?? 999) < 200 ? 'var(--ok)' : 'var(--warn)' }}>
                    ● {trackerDeviceKey()} · {poseHz} Hz · {poseStaleMs == null ? '—' : `${poseStaleMs} ms`}
                  </div>
                )}
              </>
            )}
          </Section>
          <Section title="Camera intrinsics" hint={camInt ? basename(camInt.path) : 'required'}>
            <button className="btn" onClick={onLoadIntrinsics}>↓ load yaml {camInt ? '✓' : ''}</button>
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title="Hand-Eye method" hint={method}>
            <Seg value={method} onChange={setMethod} full options={[
              {value:'tsai',label:'Tsai'},{value:'park',label:'Park'},
              {value:'horaud',label:'Horaud'},{value:'daniilidis',label:'Dan.'},{value:'andreff',label:'Andreff'}
            ]}/>
          </Section>
          <CaptureControls
            autoCapture={autoCapture} onAuto={setAutoCapture}
            autoRate={autoCaptureRate} onAutoRate={setAutoCaptureRate}
            onSnap={onSnap}
            coverage={Math.min(100, datasetFiles.length * 3)}
            coverageCells={gridCells(40, [0,1,3,4,6,7,9,10,12,14,16,17,20,22,23,26,27,30,32,34,35,38,39])}/>
          {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', padding: '0 2px' }}>{status}</div>}
        </div>
        <SolverButton onSolve={onRun} busy={busy} label="Solve AX=XB"/>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value={viewMode} onChange={setViewMode} options={[
            {value:'live',label:'live'},{value:'frame',label:'frame'},{value:'scene',label:'3D scene'}
          ]}/>
          <Chk checked={showTraj} onChange={setShowTraj}>{trackerLabel} traj</Chk>
          <Chk checked={showBoard} onChange={setShowBoard}>board</Chk>
          <div className="spacer"/>
          <div className="read">
            {result?.ok
              ? <>pairs <b>{result.iterations}</b> · rot <b>{rotRms.toFixed(3)}°</b> · trans <b>{transRms.toFixed(2)} mm</b></>
              : <>awaiting solve</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selected}
          onSelect={(id) => { setSelected(id); setViewMode('frame'); }}
          coverage={Math.min(100, datasetFiles.length * 3)}/>
        <div className="vp-body" style={{ gridTemplateColumns: '1fr 0.7fr', gap: 1, background: 'var(--view-border)' }}>
          <div className="vp-cell">
            <span className="vp-label">scene · world = tracker-base</span>
            <Scene3D w={vpW*0.6} h={vpH}>
              {(cam) => {
                const selT = mockPoses[selected % mockPoses.length];
                const T_tracker_cam = makeT(
                  rpyDeg[0] * Math.PI / 180, rpyDeg[1] * Math.PI / 180, rpyDeg[2] * Math.PI / 180,
                  tVec[0], tVec[1], tVec[2],
                );
                const Tcam = composeT(selT, T_tracker_cam);
                const Tboard = makeT(-Math.PI/2, 0, 0, 0, 0, -0.15);
                return (
                  <g>
                    {showBoard && <Chessboard3D T={Tboard} cam={cam} cols={board.cols} rows={board.rows} sq={board.sq}/>}
                    {showTraj && <Traj3D points={mockPoses.map(T => applyT(T,[0,0,0]))} cam={cam} color={trackerColor} dotEvery={6}/>}
                    <TrackerGlyph T={selT} cam={cam}/>
                    <Frustum3D T={Tcam} cam={cam} fov={0.7} aspect={1.6} label="cam"/>
                    <RigidLink3D a={applyT(selT,[0,0,0])} b={applyT(Tcam,[0,0,0])} cam={cam} color="#e3bd56"/>
                  </g>
                );
              }}
            </Scene3D>
          </div>
          <div className="vp-cell" style={{ background: 'var(--view-bg)', overflow:'hidden' }}>
            <span className="vp-label">cam image{selectedPath ? ` · ${basename(selectedPath)}` : ''}</span>
            {viewMode === 'live' && liveDevice ? (
              <LivePreview device={liveDevice}/>
            ) : selectedPath ? (
              <DetectedFrame path={selectedPath} board={board}
                showCorners={showBoard} showOrigin={true} overlay="none"/>
            ) : (
              <CameraView w={vpW*0.4} h={vpH*0.9} seed={selected+2}>
                {showBoard && <ChessboardOverlay cx={vpW*0.2} cy={vpH*0.45} cols={board.cols} rows={board.rows}
                  tile={20} rotation={-0.1} skew={0.15} tilt={0.3} showOrigin={true}/>}
              </CameraView>
            )}
          </div>
        </div>
      </div>

      <div className="rail">
        <div className="rail-header">
          <span>Results · {xmatLabel}</span>
          <span className="mono" style={{color: result?.ok ? 'var(--ok)' : 'var(--text-4)'}}>
            {result?.ok ? `● ${rotRms.toFixed(2)}° / ${transRms.toFixed(1)} mm` : busy ? '● solving' : '○ idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <Section title="Hand-Eye transform">
            <Matrix m={Tmat}/>
            <KV items={[
              ['t  (mm)', `[ ${tMm[0].toFixed(1)}, ${tMm[1].toFixed(1)}, ${tMm[2].toFixed(1)} ]`, ''],
              ['rpy (°)', `[ ${rpyDeg[0].toFixed(3)}, ${rpyDeg[1].toFixed(3)}, ${rpyDeg[2].toFixed(3)} ]`, ''],
              ['||t||',   `${tNorm.toFixed(2)} mm`, 'pos'],
            ]}/>
          </Section>
          <ErrorPanel rms={rotRms} frames={frames.map(f => f.err)} histData={histData}/>
          <Section title="Consistency" hint="world-board scatter">
            <KV items={[
              ['rot rms',   `${rotRms.toFixed(3)}°`,  rotRms < 1 ? 'pos' : 'warn'],
              ['trans rms', `${transRms.toFixed(2)} mm`, transRms < 5 ? 'pos' : 'warn'],
              ['N pairs',   `${result?.iterations ?? 0}`, ''],
            ]}/>
          </Section>
          <SolverPanel iters={result?.iterations || 0} cost={transRms} cond={0}
            algo={`cv2.calibrateHandEye · ${method}`}/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoadYaml}>↓ load</button>
          <button className="btn primary" style={{flex:1}} onClick={onSaveYaml} disabled={!result?.ok}>↑ save yaml</button>
        </div>
      </div>
    </div>
  );
}
