import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import {
  Scene3D, Tracker3D, Controller3D, Traj3D, RigidLink3D, Ground3D,
} from '../components/scene3d.jsx';
import {
  ErrorPanel, SolverButton, SolverPanel,
} from '../components/panels.jsx';
import { applyT, invT } from '../lib/math3d.js';
import { api, posesWsUrl, pickSaveFile, pickOpenFile, recording } from '../api/client.js';
import { useReportPoses } from '../lib/telemetry.jsx';

const basename = (p) => (p || '').split('/').pop();

// Cap how many samples get drawn as trajectory dots — React re-rendering the
// whole set on every WS tick would melt the UI past a few hundred points.
const TRAJ_DECIMATE_AT = 600;

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const stride = Math.ceil(arr.length / max);
  const out = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  return out;
}

// RPY (ZYX) in deg from a 3x3 nested-list rotation.
function rpyDeg(R) {
  const r = (v) => (v * 180) / Math.PI;
  const sy = Math.hypot(R[0][0], R[1][0]);
  if (sy < 1e-6) return [r(Math.atan2(-R[1][2], R[1][1])), r(Math.atan2(-R[2][0], sy)), 0];
  return [r(Math.atan2(R[2][1], R[2][2])), r(Math.atan2(-R[2][0], sy)), r(Math.atan2(R[1][0], R[0][0]))];
}

export function LinkCalibTab() {
  const [devices, setDevices] = useState(['tracker_0', 'controller_R']);
  const [devA, setDevA] = useState('tracker_0');
  const [devB, setDevB] = useState('controller_R');
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);  // recording into the sample store
  const [rate, setRate] = useState(30);
  const [sourceA, setSourceA] = useState('mock');     // 'mock' | 'oculus' | 'steamvr'
  const [sourceB, setSourceB] = useState('none');     // 'none' disables the second source
  const [oculusIp, setOculusIp] = useState('');       // optional network ADB
  const [linkLabel, setLinkLabel] = useState('tracker_to_ctrl');
  const [showTraj, setShowTraj] = useState(true);
  const [showGround, setShowGround] = useState(true);
  const [showLink, setShowLink] = useState(true);
  const [showAfter, setShowAfter] = useState(false); // overlay B re-projected through T_a_b
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);
  const [gtLink, setGtLink] = useState(null);

  // Inputs mode: 'live' (existing) or 'mcap' (new vive+mcap flow).
  const [inputsMode, setInputsMode] = useState('live');

  // Vive recording state (active only in mcap mode).
  const [recordingActive, setRecordingActive] = useState(false);
  const [viveRecCount, setViveRecCount] = useState(0);
  const [vivePath, setVivePath] = useState('');

  // UMI MCAP import state.
  const [umiPath, setUmiPath] = useState('');
  const [umiTopics, setUmiTopics] = useState([]);
  const [umiTopic, setUmiTopic] = useState('/robot0/vio/eef_pose');
  const [umiCount, setUmiCount] = useState(0);
  const [umiTimespan, setUmiTimespan] = useState(0);

  const [syncPath, setSyncPath] = useState('');
  const [syncDiag, setSyncDiag] = useState(null);     // { delta_t, n_pairs, vive_rot_deg, umi_rot_deg }
  const [solveMethod, setSolveMethod] = useState('daniilidis');

  // Sample store (kept in refs to avoid React thrash at 30 Hz).
  const samplesRef = useRef({});  // device → array of {seq, ts, T}
  const wsRef = useRef(null);
  // Wall-clock timestamped pose buffer for the active recording session.
  const recordingRef = useRef([]);  // [{ ts: <epoch_s>, T: [[4x4]] }]
  const recordingActiveRef = useRef(false);
  const [tickCount, setTickCount] = useState(0); // one re-render per ~10 samples to refresh viz

  // Telemetry state for the topbar pills. Refs so the WS onmessage closure
  // doesn't have to be rebuilt on every update; the React state is what we
  // hand to useReportPoses (so context updates flow normally).
  const helloRef    = useRef({ source: [], bases: 0, devices: [] });
  const ticksRef    = useRef({});                 // { [name]: Array<{ts, present}> }
  const [poseStats, setPoseStats] = useState(null);
  useReportPoses(poseStats);

  // Snapshot of the two trajectories for rendering; rebuilt from samplesRef each tick.
  const [viz, setViz] = useState({ a: [], b: [], curA: null, curB: null });

  const flushViz = useCallback(() => {
    const a = samplesRef.current[devA] ?? [];
    const b = samplesRef.current[devB] ?? [];
    const aDrawn = downsample(a, TRAJ_DECIMATE_AT);
    const bDrawn = downsample(b, TRAJ_DECIMATE_AT);
    setViz({
      a: aDrawn, b: bDrawn,
      curA: a.length ? a[a.length - 1].T : null,
      curB: b.length ? b[b.length - 1].T : null,
    });
  }, [devA, devB]);

  useEffect(() => { flushViz(); /* refresh on device re-mapping */ }, [flushViz, tickCount]);

  const connect = useCallback(async () => {
    if (wsRef.current) return;
    setStatus('connecting…');
    try {
      const picked = [sourceA, sourceB].filter(s => s && s !== 'none');
      const url = await posesWsUrl({
        fps: rate,
        sources: picked,
        ip: picked.includes('oculus') && oculusIp ? oculusIp : undefined,
      });
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); setStatus('connected · awaiting poses'); };
      ws.onclose = (ev) => {
        setConnected(false); setStreaming(false);
        if (ev.code !== 1000) setStatus(`ws closed (${ev.code})`);
        wsRef.current = null;
      };
      ws.onerror = () => setStatus('ws error');
      let sinceFlush = 0;
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'error') {
          setStatus(`${m.source} error: ${m.message}`);
          return;
        }
        if (m.type === 'hello') {
          setDevices(m.devices || []);
          if (Array.isArray(m.devices) && m.devices.length >= 2) {
            setDevA(m.devices[0]);
            setDevB(m.devices[1]);
          }
          setGtLink(m.gt_T_a_b || null);
          const srcTag = Array.isArray(m.sources) ? m.sources.join('+') : (m.source ?? 'mock');
          setStatus(`hello · ${srcTag} · ${m.devices?.length ?? 0} devices · ${m.fps} Hz`);
          helloRef.current = {
            source: Array.isArray(m.sources) ? m.sources : (m.source ? [m.source] : []),
            bases: Number.isFinite(m.bases) ? m.bases : 0,
            devices: Array.isArray(m.devices) ? m.devices : [],
          };
          ticksRef.current = Object.fromEntries((m.devices ?? []).map(d => [d, []]));
          return;
        }
        if (m.type !== 'sample') return;
        const samplePoses = m.poses || {};
        const nowMs = performance.now();
        const cutoffMs = nowMs - 5000;
        for (const dev of helloRef.current.devices) {
          const arr = ticksRef.current[dev] || (ticksRef.current[dev] = []);
          arr.push({ ts: nowMs, present: dev in samplePoses });
          // Trim the ring to the 5 s window.
          while (arr.length && arr[0].ts < cutoffMs) arr.shift();
        }
        // Vive recording: capture wall-clock-stamped poses for the device the user picked.
        if (recordingActiveRef.current && m.wall_ts != null) {
          const T = samplePoses[devA];
          if (T) {
            recordingRef.current.push({ ts: m.wall_ts, T });
            // Throttle re-renders of the count display: bump every 10 samples.
            if (recordingRef.current.length % 10 === 0) {
              setViveRecCount(recordingRef.current.length);
            }
          }
        }
        // Sample collection gate — controlled by `streaming`. Read the ref so the
        // onmessage closure doesn't need to be rebuilt every time the flag flips.
        if (!collectingRef.current) return;
        const poses = samplePoses;
        for (const [dev, T] of Object.entries(poses)) {
          if (!samplesRef.current[dev]) samplesRef.current[dev] = [];
          samplesRef.current[dev].push({ seq: m.seq, ts: m.ts, T });
        }
        sinceFlush++;
        if (sinceFlush >= 10) {
          sinceFlush = 0;
          setTickCount(n => n + 1);
        }
      };
    } catch (e) {
      setStatus(`connect failed: ${e.message}`);
    }
  }, [rate, sourceA, sourceB, oculusIp]);

  const disconnect = useCallback(() => {
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    setConnected(false); setStreaming(false);
    setPoseStats(null);
  }, []);

  const startRecording = useCallback(() => {
    if (!connected) { setStatus('connect first'); return; }
    recordingRef.current = [];
    recordingActiveRef.current = true;
    setRecordingActive(true);
    setViveRecCount(0);
    setStatus('recording…');
  }, [connected]);

  const stopAndSaveRecording = useCallback(async () => {
    recordingActiveRef.current = false;
    setRecordingActive(false);
    const samples = recordingRef.current.slice();
    setViveRecCount(samples.length);
    if (samples.length === 0) { setStatus('nothing recorded'); return; }
    const path = await pickSaveFile({ defaultPath: 'vive_recording.json' });
    if (!path) { setStatus('save cancelled (kept buffer)'); return; }
    try {
      const r = await recording.save({ kind: 'vive', samples, path });
      setVivePath(r.path);
      setStatus(`saved vive ${r.n} samples → ${path.split('/').pop()}`);
    } catch (e) { setStatus(`save failed: ${e.message}`); }
  }, []);

  const onImportMcap = useCallback(async () => {
    const mcap_path = await pickOpenFile({ filters: [{ name: 'MCAP', extensions: ['mcap'] }] });
    if (!mcap_path) return;
    setStatus('listing topics…');
    try {
      const t = await recording.listTopics(mcap_path);
      const topics = t.topics || [];
      setUmiTopics(topics);
      if (topics.length === 0) { setStatus('no PoseInFrame topics in that mcap'); return; }
      const default_topic = topics.find(x => x.topic === umiTopic) ? umiTopic : topics[0].topic;
      setUmiTopic(default_topic);
      const out_path = await pickSaveFile({ defaultPath: 'umi_recording.json' });
      if (!out_path) { setStatus('import cancelled'); return; }
      setStatus(`importing ${default_topic}…`);
      const r = await recording.importMcap({ mcap_path, topic: default_topic, out_path });
      setUmiPath(r.path);
      setUmiCount(r.count);
      setUmiTimespan(r.t_last - r.t_first);
      setStatus(`imported ${r.count} samples · ${(r.t_last - r.t_first).toFixed(1)}s`);
    } catch (e) { setStatus(`import failed: ${e.message}`); }
  }, [umiTopic]);

  const onSync = useCallback(async () => {
    if (!vivePath) { setStatus('record vive first'); return; }
    if (!umiPath) { setStatus('import mcap first'); return; }
    const out_path = await pickSaveFile({ defaultPath: 'synced.json' });
    if (!out_path) return;
    setStatus('syncing…');
    try {
      const r = await recording.sync({ vive_path: vivePath, umi_path: umiPath, out_path });
      setSyncPath(r.path);
      setSyncDiag({
        delta_t: r.delta_t,
        n_pairs: r.n_pairs,
        vive_rot_deg: r.vive_rot_deg,
        umi_rot_deg: r.umi_rot_deg,
      });
      setStatus(`synced · Δt ${r.delta_t.toFixed(3)}s · ${r.n_pairs} pairs`);
    } catch (e) { setStatus(`sync failed: ${e.message}`); }
  }, [vivePath, umiPath]);

  const onSolveLink = useCallback(async () => {
    if (!syncPath) { setStatus('sync first'); return; }
    setBusy(true);
    setStatus('solving handeye…');
    try {
      const r = await recording.calibrateHandeyePose({ synced_path: syncPath, method: solveMethod });
      setResult(r);
      setStatus(r.ok ? `T_vive_umi · rms ${r.rms.toFixed(3)}° · ${r.message}` : `failed: ${r.message}`);
    } catch (e) { setStatus(`solve failed: ${e.message}`); }
    finally { setBusy(false); }
  }, [syncPath, solveMethod]);

  const solveGate = (() => {
    if (!syncDiag) return 'run sync first';
    if (syncDiag.n_pairs < 50) return `only ${syncDiag.n_pairs} pairs (need ≥ 50)`;
    if (syncDiag.vive_rot_deg < 30) return `vive rotation diversity too low: ${syncDiag.vive_rot_deg.toFixed(1)}°`;
    if (syncDiag.umi_rot_deg < 30) return `umi rotation diversity too low: ${syncDiag.umi_rot_deg.toFixed(1)}°`;
    return null;
  })();

  // Use a ref for `streaming` inside onmessage to avoid re-subscribing.
  const collectingRef = useRef(false);
  useEffect(() => { collectingRef.current = streaming; }, [streaming]);

  useEffect(() => () => disconnect(), [disconnect]);

  // Recompute per-device drop% from the rolling 5 s window and push to the
  // TelemetryProvider so the topbar's SteamVR/tracker pills update. Cleared
  // when no WS is connected.
  useEffect(() => {
    if (!connected) {
      setPoseStats(null);
      return;
    }
    const id = setInterval(() => {
      const { source, bases, devices } = helloRef.current;
      const perDevice = {};
      for (const dev of devices) {
        const arr = ticksRef.current[dev] || [];
        if (arr.length === 0) {
          perDevice[dev] = { dropPct: 0 };
          continue;
        }
        const absent = arr.reduce((n, e) => n + (e.present ? 0 : 1), 0);
        perDevice[dev] = { dropPct: (absent / arr.length) * 100 };
      }
      setPoseStats({ source, bases, perDevice });
    }, 500);
    return () => clearInterval(id);
  }, [connected]);

  const clearSamples = () => {
    samplesRef.current = {};
    setTickCount(n => n + 1);
    setResult(null);
    setStatus('cleared');
  };

  const onSolve = async () => {
    const sa = samplesRef.current[devA] ?? [];
    const sb = samplesRef.current[devB] ?? [];
    if (sa.length < 2 || sb.length < 2) {
      setStatus(`need ≥ 2 samples per device — have A:${sa.length} B:${sb.length}`);
      return;
    }
    // Pair by sample seq (backend sends same seq for both devices per tick).
    const bBySeq = new Map(sb.map(s => [s.seq, s.T]));
    const poses_a = {};
    const poses_b = {};
    for (const s of sa) {
      if (bBySeq.has(s.seq)) {
        poses_a[String(s.seq)] = s.T;
        poses_b[String(s.seq)] = bBySeq.get(s.seq);
      }
    }
    const n = Object.keys(poses_a).length;
    if (n < 2) { setStatus(`no seq-matched pairs, got ${n}`); return; }
    setBusy(true); setStatus(`solving · ${n} pairs…`);
    try {
      const res = await api.calibrate('link', {
        poses_a, poses_b, link_label: linkLabel,
      });
      setResult(res);
      setStatus(res.ok
        ? `rot ${res.rms.toFixed(4)}° · trans ${res.final_cost.toFixed(3)} mm · ${res.message}`
        : `failed: ${res.message}`);
    } catch (e) { setStatus(`error: ${e.message}`); } finally { setBusy(false); }
  };

  const onSaveYaml = async () => {
    if (!result?.ok) { setStatus('nothing to save — run solve first'); return; }
    const p = await pickSaveFile({ defaultPath: `link_${linkLabel}.yaml` });
    if (!p) return;
    try {
      await api.saveCalibration({ path: p, kind: 'chain', result });
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
        T: d.T || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0, message: `loaded from ${p}`,
      });
      setStatus(`loaded ← ${p}`);
    } catch (e) { setStatus(`load failed: ${e.message}`); }
  };

  const Tmat = result?.T ?? [
    [1, 0, 0, 0.05],
    [0, 1, 0, 0],
    [0, 0, 1, 0.05],
    [0, 0, 0, 1],
  ];
  const tVec = [Tmat[0][3], Tmat[1][3], Tmat[2][3]];
  const tMm = tVec.map(v => v * 1000);
  const tNorm = Math.hypot(...tMm);
  const R = [[Tmat[0][0], Tmat[0][1], Tmat[0][2]],
             [Tmat[1][0], Tmat[1][1], Tmat[1][2]],
             [Tmat[2][0], Tmat[2][1], Tmat[2][2]]];
  const rpy = rpyDeg(R);
  const rotRms = result?.ok ? result.rms : 0;
  const transRms = result?.ok ? result.final_cost : 0;

  const histData = useMemo(() => result?.per_frame_err?.length
    ? result.per_frame_err : [],
    [result]);

  const countA = samplesRef.current[devA]?.length ?? 0;
  const countB = samplesRef.current[devB]?.length ?? 0;

  const vpW = 900, vpH = 620;

  const pts = (arr) => arr.map(s => applyT(s.T, [0, 0, 0]));

  // "After extrinsics" overlay: take each B sample and map it through X⁻¹ to
  // predict where A would be. If T_a_b is correct, this trace sits on top of A.
  // Memoize because it only changes when result.T or viz.b changes.
  const predictedA = useMemo(() => {
    if (!result?.ok || !result.T || !viz.b?.length) return [];
    const X = result.T;
    const Xi = invT(X);
    const offset = applyT(Xi, [0, 0, 0]);  // A origin as seen in B's frame
    return viz.b.map(s => applyT(s.T, offset));
  }, [result, viz.b]);

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>Link · tracker ↔ controller</span>
          <span className="mono" style={{color: connected ? 'var(--ok)' : 'var(--text-4)'}}>
            {connected ? (streaming ? '● live' : '● paused') : '○ offline'}
          </span>
        </div>
        <div className="rail-scroll">
          <Section title="Inputs">
            <Seg value={inputsMode} onChange={setInputsMode} full options={[
              {value:'live', label:'live pair'},
              {value:'mcap', label:'vive + mcap'},
            ]}/>
          </Section>
          {inputsMode === 'live' && (
            <>
          <Section title="Pose source" hint={sourceB === 'none' ? sourceA : `${sourceA} + ${sourceB}`}>
            <Field label="source A">
              <select className="select" value={sourceA} disabled={connected}
                onChange={e => setSourceA(e.target.value)}>
                <option value="mock">mock (Lissajous)</option>
                <option value="oculus">oculus (Quest3s)</option>
                <option value="steamvr">steamvr (Vive tracker)</option>
              </select>
            </Field>
            <Field label="source B">
              <select className="select" value={sourceB} disabled={connected}
                onChange={e => setSourceB(e.target.value)}>
                <option value="none">— (single source)</option>
                <option value="mock">mock (Lissajous)</option>
                <option value="oculus">oculus (Quest3s)</option>
                <option value="steamvr">steamvr (Vive tracker)</option>
              </select>
            </Field>
            {(sourceA === 'oculus' || sourceB === 'oculus') && (
              <Field label="adb ip">
                <input className="input" placeholder="(blank = USB)" value={oculusIp}
                  disabled={connected}
                  onChange={e => setOculusIp(e.target.value)}/>
              </Field>
            )}
            <Field label="fps">
              <input type="number" className="input" value={rate} min={1} max={120}
                onChange={e => setRate(+e.target.value || 30)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              {!connected
                ? <button className="btn primary" onClick={connect}>⚡ connect</button>
                : <button className="btn ghost" onClick={disconnect}>⨯ disconnect</button>}
              {connected && (
                streaming
                  ? <button className="btn" onClick={() => setStreaming(false)}>⏸ pause</button>
                  : <button className="btn" onClick={() => setStreaming(true)}>● record</button>
              )}
            </div>
          </Section>
          <Section title="Device mapping" hint={`${devices.length} devices`}>
            <Field label="A (from)">
              <select className="select" value={devA} onChange={e => setDevA(e.target.value)}>
                {devices.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="B (to)">
              <select className="select" value={devB} onChange={e => setDevB(e.target.value)}>
                {devices.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="link label">
              <input className="input" value={linkLabel} onChange={e => setLinkLabel(e.target.value)}/>
            </Field>
          </Section>
          <Section title="Samples" hint={`${countA} / ${countB}`}>
            <KV items={[
              [devA, `${countA}`, countA > 20 ? 'pos' : ''],
              [devB, `${countB}`, countB > 20 ? 'pos' : ''],
            ]}/>
            <button className="btn ghost" onClick={clearSamples}>⌫ clear all</button>
          </Section>
          <Section title="Solver" hint="SE(3) chordal mean">
            <Chk checked={true} onChange={()=>{}}>enforce rigid link (SO(3) projection)</Chk>
            <Chk checked={false} onChange={()=>{}}>reject motion &lt; 5°</Chk>
            <Chk checked={false} onChange={()=>{}}>outlier reject (&gt; 3σ)</Chk>
          </Section>
          {gtLink && (
            <Section title="Ground truth (mock)" hint="for verification">
              <div className="mono" style={{fontSize: 10.5, color:'var(--text-3)'}}>
                t_gt = [{(gtLink[0][3]*1000).toFixed(2)}, {(gtLink[1][3]*1000).toFixed(2)}, {(gtLink[2][3]*1000).toFixed(2)}] mm
              </div>
            </Section>
          )}
            </>
          )}
          {inputsMode === 'mcap' && (
            <>
              <Section title="Vive recording" hint={connected ? `${viveRecCount} samples` : 'not connected'}>
                <Field label="source">
                  <Seg value={sourceA} onChange={setSourceA} full options={[
                    {value:'mock', label:'mock'},
                    {value:'steamvr', label:'steamvr'},
                  ]}/>
                </Field>
                <Field label="device">
                  <select className="select" value={devA} onChange={e => setDevA(e.target.value)}>
                    {devices.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </Field>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  {connected
                    ? <button className="btn ghost" onClick={disconnect}>disconnect</button>
                    : <button className="btn" onClick={connect}>connect</button>}
                  {recordingActive
                    ? <button className="btn primary" onClick={stopAndSaveRecording}>⏹ stop & save</button>
                    : <button className="btn" disabled={!connected} onClick={startRecording}>● start recording</button>}
                </div>
                {vivePath && <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>saved: {vivePath}</div>}
              </Section>
                <Section title="UMI MCAP" hint={umiCount ? `${umiCount} samples · ${umiTimespan.toFixed(1)}s` : 'not loaded'}>
                  <button className="btn" onClick={onImportMcap}>↓ import mcap</button>
                  {umiTopics.length > 0 && (
                    <Field label="topic">
                      <select className="select" value={umiTopic} onChange={e => setUmiTopic(e.target.value)}>
                        {umiTopics.map(t => <option key={t.topic} value={t.topic}>{t.topic} ({t.n})</option>)}
                      </select>
                    </Field>
                  )}
                  {umiPath && <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>{umiPath}</div>}
                </Section>
                <Section title="Sync" hint={syncDiag ? `${syncDiag.n_pairs} pairs · Δt ${syncDiag.delta_t.toFixed(3)}s` : 'not synced'}>
                  <button className="btn" onClick={onSync} disabled={!vivePath || !umiPath}>⚡ sync</button>
                  {syncDiag && (
                    <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)', display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                      <span>Δt</span><span>{syncDiag.delta_t.toFixed(3)} s</span>
                      <span>pairs</span><span>{syncDiag.n_pairs}</span>
                      <span>vive rot</span><span>{syncDiag.vive_rot_deg.toFixed(1)}°</span>
                      <span>umi rot</span><span>{syncDiag.umi_rot_deg.toFixed(1)}°</span>
                    </div>
                  )}
                </Section>
                <Section title="Solve" hint={solveGate ? 'gated' : 'ready'}>
                  <Field label="method">
                    <select className="select" value={solveMethod} onChange={e => setSolveMethod(e.target.value)}>
                      <option value="daniilidis">daniilidis</option>
                      <option value="tsai">tsai</option>
                      <option value="park">park</option>
                      <option value="horaud">horaud</option>
                      <option value="andreff">andreff</option>
                    </select>
                  </Field>
                  <button className="btn primary" onClick={onSolveLink}
                          disabled={!!solveGate || busy}
                          title={solveGate || ''}>
                    Solve T_vive_umi
                  </button>
                  {solveGate && <div className="mono" style={{ fontSize: 10.5, color:'var(--warn)' }}>{solveGate}</div>}
                </Section>
            </>
          )}
          {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', padding: '0 2px' }}>{status}</div>}
        </div>
        {inputsMode === 'live' && <SolverButton onSolve={onSolve} busy={busy} label={`Solve ${linkLabel}`}/>}
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value="scene" onChange={()=>{}} options={[{value:'scene',label:'3D scene'}]}/>
          <Chk checked={showTraj} onChange={setShowTraj}>trajectories</Chk>
          <Chk checked={showLink} onChange={setShowLink}>rigid link</Chk>
          <Chk checked={showGround} onChange={setShowGround}>ground grid</Chk>
          <button
            className={`btn ${showAfter ? 'primary' : 'ghost'}`}
            disabled={!result?.ok}
            onClick={() => setShowAfter(v => !v)}
            title={result?.ok
              ? 'overlay B re-projected through T_a_b onto A'
              : 'solve first to enable'}>
            {showAfter ? '◉' : '○'} after extrinsics
          </button>
          <div className="spacer"/>
          <div className="read">
            {result?.ok
              ? <>‖t‖ <b>{tNorm.toFixed(2)} mm</b> · rot rms <b>{rotRms.toFixed(3)}°</b> · trans rms <b>{transRms.toFixed(2)} mm</b></>
              : <>pairs <b>{Math.min(countA, countB)}</b> · awaiting solve</>}
          </div>
        </div>
        <div className="vp-body" style={{ gridTemplateColumns: '1fr', gap: 1, background: 'var(--view-border)' }}>
          <div className="vp-cell">
            <span className="vp-label">world · base-station frame</span>
            <Scene3D w={vpW} h={vpH}>
              {(cam) => (
                <g>
                  {showGround && <Ground3D cam={cam} size={0.6} step={0.05} z={-0.12}/>}
                  {showTraj && viz.a.length > 1 && (
                    <Traj3D points={pts(viz.a)} cam={cam} color="#ffa95a" dotEvery={8}/>
                  )}
                  {showTraj && viz.b.length > 1 && (
                    <Traj3D points={pts(viz.b)} cam={cam} color="#b78cff" dotEvery={8}/>
                  )}
                  {showAfter && predictedA.length > 1 && (
                    <Traj3D points={predictedA} cam={cam} color="#7fffbf" dotEvery={8}/>
                  )}
                  {viz.curA && <Tracker3D    T={viz.curA} cam={cam} label={devA}/>}
                  {viz.curB && <Controller3D T={viz.curB} cam={cam} label={devB}/>}
                  {showLink && viz.curA && viz.curB && (
                    <RigidLink3D
                      a={applyT(viz.curA, [0,0,0])}
                      b={applyT(viz.curB, [0,0,0])}
                      cam={cam} color="#e3bd56"/>
                  )}
                </g>
              )}
            </Scene3D>
            <div className="vp-corner-read">
              <div>A <b style={{color:'#ffa95a'}}>{devA}</b> · {countA} pts</div>
              <div>B <b style={{color:'#b78cff'}}>{devB}</b> · {countB} pts</div>
              {showAfter && predictedA.length > 0 && (
                <div><b style={{color:'#7fffbf'}}>B·X⁻¹</b> → predicted A</div>
              )}
              {viz.curA && (
                <div>pA [{(viz.curA[0][3]).toFixed(3)}, {(viz.curA[1][3]).toFixed(3)}, {(viz.curA[2][3]).toFixed(3)}]</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="rail">
        <div className="rail-header">
          <span>Results · T_a_b</span>
          <span className="mono" style={{color: result?.ok ? 'var(--ok)' : 'var(--text-4)'}}>
            {result?.ok ? `● ${transRms.toFixed(2)} mm` : busy ? '● solving' : '○ idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <Section title={`T · ${linkLabel}`}>
            <Matrix m={Tmat}/>
            <KV items={[
              ['t (mm)',  `[ ${tMm[0].toFixed(2)}, ${tMm[1].toFixed(2)}, ${tMm[2].toFixed(2)} ]`, ''],
              ['rpy (°)', `[ ${rpy[0].toFixed(3)}, ${rpy[1].toFixed(3)}, ${rpy[2].toFixed(3)} ]`, ''],
              ['||t||',   `${tNorm.toFixed(2)} mm`, 'pos'],
            ]}/>
          </Section>
          <Section title="Residuals" hint="per-pair deviation">
            <KV items={[
              ['rot rms',  `${rotRms.toFixed(4)}°`, rotRms < 0.5 ? 'pos' : 'warn'],
              ['trans rms',`${transRms.toFixed(3)} mm`, transRms < 2 ? 'pos' : 'warn'],
              ['N pairs',  `${result?.iterations ?? 0}`, ''],
            ]}/>
          </Section>
          {histData.length > 0 && (
            <ErrorPanel rms={transRms} frames={histData.slice(0, 60)} histData={histData}/>
          )}
          <SolverPanel iters={result?.iterations || 0} cost={transRms} cond={0}
            algo="SE(3) chordal-mean + SVD projection"/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoadYaml}>↓ load</button>
          <button className="btn primary" style={{flex:1}} onClick={onSaveYaml} disabled={!result?.ok}>↑ save yaml</button>
        </div>
      </div>
    </div>
  );
}
