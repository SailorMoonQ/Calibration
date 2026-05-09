import { useCallback, useMemo, useRef, useState } from 'react';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import {
  Scene3D, Tracker3D, Controller3D, Traj3D, RigidLink3D, Ground3D,
} from '../components/scene3d.jsx';
import { ErrorPanel, SolverPanel } from '../components/panels.jsx';
import { applyT, invT } from '../lib/math3d.js';
import { api, pickSaveFile, pickOpenFile, recording } from '../api/client.js';
import { useReportPoses } from '../lib/telemetry.jsx';
import { initialSlot, slotReady, slotPath, useSlotWs } from './_linkSlot.js';


const TRAJ_DECIMATE_AT = 600;

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const stride = Math.ceil(arr.length / max);
  const out = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  return out;
}

function rpyDeg(R) {
  const r = (v) => (v * 180) / Math.PI;
  const sy = Math.hypot(R[0][0], R[1][0]);
  if (sy < 1e-6) return [r(Math.atan2(-R[1][2], R[1][1])), r(Math.atan2(-R[2][0], sy)), 0];
  return [r(Math.atan2(R[2][1], R[2][2])), r(Math.atan2(-R[2][0], sy)), r(Math.atan2(R[1][0], R[0][0]))];
}

export function LinkCalibTab({ solvePattern }) {
  const [slotA, setSlotA] = useState(() => initialSlot({ backend: 'steamvr' }));
  const [slotB, setSlotB] = useState(() => initialSlot({ format: 'mcap' }));
  const [linkLabel, setLinkLabel] = useState('a_to_b');
  const [showTraj, setShowTraj] = useState(true);
  const [showGround, setShowGround] = useState(true);
  const [showLink, setShowLink] = useState(true);
  const [showAfter, setShowAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);
  const [syncPath, setSyncPath] = useState('');
  const [syncEst, setSyncEst] = useState(null);   // estimator output: {delta_t, snr, a_rot_deg, b_rot_deg}
  const [deltaT, setDeltaT] = useState(null);     // user-tunable Δt — initialised from the estimate
  const [syncDiag, setSyncDiag] = useState(null); // post-apply: {delta_t, n_pairs, a_rot_deg, b_rot_deg}
  const [solveMethod, setSolveMethod] = useState('daniilidis');
  const [tickCount, setTickCount] = useState(0);
  const [poseStats] = useState(null);
  useReportPoses(poseStats);

  // Tracks user intent for live-mode slots; the WS hook reacts to this.
  const [wantA, setWantA] = useState(false);
  const [wantB, setWantB] = useState(false);

  // Per-slot live sample buffers (refs to avoid re-render at 30 Hz).
  const slotsBufA = useRef({ viz: [], rec: [], curT: null }).current;
  const slotsBufB = useRef({ viz: [], rec: [], curT: null }).current;

  function handleSample(m, slot, buf) {
    const samplePoses = m.poses || {};
    const T = slot.device ? samplePoses[slot.device] : null;
    if (!T) return;
    buf.curT = T;
    buf.viz.push({ seq: m.seq, ts: m.ts, T });
    if (slot.recording && m.wall_ts != null) {
      buf.rec.push({ ts: m.wall_ts, T });
    }
    // Throttle re-renders.
    if (buf.viz.length % 10 === 0) setTickCount(n => n + 1);
  }

  const handleSampleA = useCallback((m) => handleSample(m, slotA, slotsBufA), [slotA, slotsBufA]);
  const handleSampleB = useCallback((m) => handleSample(m, slotB, slotsBufB), [slotB, slotsBufB]);

  useSlotWs({
    slot: slotA, setSlot: setSlotA, wantConnected: wantA,
    onSample: handleSampleA,
    onError: (msg) => setStatus(`A: ${msg}`),
  });
  useSlotWs({
    slot: slotB, setSlot: setSlotB, wantConnected: wantB,
    onSample: handleSampleB,
    onError: (msg) => setStatus(`B: ${msg}`),
  });

  // Live-mode controls --------------------------------------------------------
  const startRec = (slot, setSlot, buf) => {
    if (!slot.connected) { setStatus('connect first'); return; }
    buf.rec.length = 0;
    setSlot(s => ({ ...s, recording: true, recordedPath: null, recCount: 0 }));
  };

  const stopAndSaveRec = async (slot, setSlot, buf, label) => {
    setSlot(s => ({ ...s, recording: false }));
    const samples = buf.rec.slice();
    if (samples.length === 0) { setStatus(`${label}: nothing recorded`); return; }
    const path = await pickSaveFile({ defaultPath: `${label}_recording.json` });
    if (!path) { setStatus(`${label}: save cancelled`); return; }
    try {
      const r = await recording.save({ kind: 'vive', samples, path });
      setSlot(s => ({ ...s, recordedPath: r.path, recCount: r.n }));
      setStatus(`${label}: saved ${r.n} → ${path.split('/').pop()}`);
    } catch (e) { setStatus(`${label}: save failed: ${e.message}`); }
  };

  // Import-mode controls -----------------------------------------------------
  const importFile = async (slot, setSlot, label) => {
    const filters = slot.format === 'mcap'
      ? [{ name: 'MCAP', extensions: ['mcap'] }]
      : slot.format === 'yaml'
        ? [{ name: 'YAML', extensions: ['yaml', 'yml'] }]
        : [{ name: 'JSON', extensions: ['json'] }];
    const path = await pickOpenFile({ filters });
    if (!path) return;
    setSlot(s => ({ ...s, filePath: path, importedPath: null, mcapTopics: [], mcapTopic: null,
                    importMeta: null, devices: [], device: null }));
    setStatus(`${label}: loading…`);
    try {
      if (slot.format === 'mcap') {
        const t = await recording.listTopics(path);
        const topics = t.topics || [];
        if (topics.length === 0) { setStatus(`${label}: no PoseInFrame topics`); return; }
        setSlot(s => ({ ...s, mcapTopics: topics, mcapTopic: topics[0].topic }));
        setStatus(`${label}: ${topics.length} topics — pick one`);
      } else {
        const r = await recording.importFile({ path, format: slot.format });
        const dev = r.device || 'imported';
        setSlot(s => ({
          ...s,
          importedPath: r.path,
          importMeta: { n: r.count, t_first: r.t_first, t_last: r.t_last, device: r.device },
          devices: [dev],
          device: dev,
        }));
        setStatus(`${label}: loaded ${r.count} samples · Δ${(r.t_last - r.t_first).toFixed(1)}s`);
      }
    } catch (e) { setStatus(`${label}: import failed: ${e.message}`); }
  };

  const importMcapTopic = async (slot, setSlot, label) => {
    if (!slot.filePath || !slot.mcapTopic) return;
    const out_path = await pickSaveFile({ defaultPath: `${label}_umi.json` });
    if (!out_path) return;
    setStatus(`${label}: importing ${slot.mcapTopic}…`);
    try {
      const r = await recording.importMcap({ mcap_path: slot.filePath, topic: slot.mcapTopic, out_path });
      const dev = slot.mcapTopic.split('/').pop() || 'mcap';
      setSlot(s => ({
        ...s,
        importedPath: r.path,
        importMeta: { n: r.count, t_first: r.t_first, t_last: r.t_last, device: dev },
        devices: [dev],
        device: dev,
      }));
      setStatus(`${label}: imported ${r.count} · Δ${(r.t_last - r.t_first).toFixed(1)}s`);
    } catch (e) { setStatus(`${label}: import failed: ${e.message}`); }
  };

  // Mode flip wipes mode-specific state but preserves slot identity ----------
  const flipMode = (setSlot, setWant, mode) => {
    setWant(false);   // always reset connect-intent on mode change
    setSlot(s => ({
      ...initialSlot(),
      mode,
      backend: s.backend, adbIp: s.adbIp, fps: s.fps, format: s.format,
    }));
  };

  const onEstimate = useCallback(async () => {
    const a = slotPath(slotA);
    const b = slotPath(slotB);
    if (!a || !b) { setStatus('both slots must be ready'); return; }
    setStatus('estimating Δt…');
    try {
      const r = await recording.estimateSync({ a_path: a, b_path: b });
      const est = {
        delta_t: r.delta_t,
        snr: r.snr,
        a_rot_deg: r.a_rot_deg ?? r.vive_rot_deg,
        b_rot_deg: r.b_rot_deg ?? r.umi_rot_deg,
      };
      setSyncEst(est);
      setDeltaT(est.delta_t);
      // estimating again invalidates any previously-locked pairs
      setSyncDiag(null);
      setSyncPath('');
      setStatus(`estimate · Δt ${est.delta_t.toFixed(3)}s · SNR ${est.snr.toFixed(2)}`);
    } catch (e) { setStatus(`estimate failed: ${e.message}`); }
  }, [slotA, slotB]);

  const onApply = useCallback(async () => {
    const a = slotPath(slotA);
    const b = slotPath(slotB);
    if (!a || !b) { setStatus('both slots must be ready'); return; }
    if (!Number.isFinite(deltaT)) { setStatus('Δt must be a number'); return; }
    const out_path = await pickSaveFile({ defaultPath: `synced_${linkLabel}.json` });
    if (!out_path) return;
    setStatus('pairing…');
    try {
      const r = await recording.sync({
        a_path: a, b_path: b, out_path, delta_t_override: deltaT,
      });
      setSyncPath(r.path);
      setSyncDiag({
        delta_t: r.delta_t,
        n_pairs: r.n_pairs,
        a_rot_deg: r.a_rot_deg ?? r.vive_rot_deg,
        b_rot_deg: r.b_rot_deg ?? r.umi_rot_deg,
      });
      setStatus(`paired · Δt ${r.delta_t.toFixed(3)}s · ${r.n_pairs} pairs`);
    } catch (e) { setStatus(`apply failed: ${e.message}`); }
  }, [slotA, slotB, deltaT, linkLabel]);

  const onSolve = useCallback(async () => {
    if (!syncPath) { setStatus('sync first'); return; }
    setBusy(true); setStatus('solving handeye…');
    try {
      const r = await recording.calibrateHandeyePose({
        synced_path: syncPath, method: solveMethod, pattern: solvePattern,
      });
      setResult(r);
      setStatus(r.ok ? `T_${linkLabel} · rms ${r.rms.toFixed(3)}° · ${r.message}` : `failed: ${r.message}`);
    } catch (e) { setStatus(`solve failed: ${e.message}`); }
    finally { setBusy(false); }
  }, [syncPath, solveMethod, solvePattern, linkLabel]);

  const onSaveYaml = useCallback(async () => {
    if (!result?.ok) { setStatus('nothing to save — run solve first'); return; }
    const p = await pickSaveFile({ defaultPath: `link_${linkLabel}.yaml` });
    if (!p) return;
    try {
      await api.saveCalibration({ path: p, kind: 'chain', result });
      setStatus(`saved → ${p}`);
    } catch (e) { setStatus(`save failed: ${e.message}`); }
  }, [result, linkLabel]);

  const onLoadYaml = useCallback(async () => {
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
  }, []);

  const solveGate = (() => {
    if (!syncDiag) return 'run sync first';
    if (syncDiag.n_pairs < 50) return `only ${syncDiag.n_pairs} pairs (need ≥ 50)`;
    if (syncDiag.a_rot_deg < 30) return `A rotation diversity too low: ${syncDiag.a_rot_deg.toFixed(1)}°`;
    if (syncDiag.b_rot_deg < 30) return `B rotation diversity too low: ${syncDiag.b_rot_deg.toFixed(1)}°`;
    return null;
  })();

  // Viewport data ------------------------------------------------------------
  const vizA = useMemo(() => {
    if (slotA.mode === 'live') return downsample(slotsBufA.viz, TRAJ_DECIMATE_AT);
    return [];  // import-mode trajectory rendering is a known follow-up — see open issues
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotA.mode, tickCount]);
  const vizB = useMemo(() => {
    if (slotB.mode === 'live') return downsample(slotsBufB.viz, TRAJ_DECIMATE_AT);
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotB.mode, tickCount]);
  const curA = slotA.mode === 'live' ? slotsBufA.curT : null;
  const curB = slotB.mode === 'live' ? slotsBufB.curT : null;

  const Tmat = result?.T ?? [
    [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
  ];
  const tVec = [Tmat[0][3], Tmat[1][3], Tmat[2][3]];
  const tMm = tVec.map(v => v * 1000);
  const tNorm = Math.hypot(...tMm);
  const R = [[Tmat[0][0], Tmat[0][1], Tmat[0][2]],
             [Tmat[1][0], Tmat[1][1], Tmat[1][2]],
             [Tmat[2][0], Tmat[2][1], Tmat[2][2]]];
  const rpy = rpyDeg(R);
  const rotRms = result?.ok ? result.rms : 0;
  const transRms = result?.ok ? (result.final_cost ?? 0) : 0;

  const histData = useMemo(() => result?.per_frame_err?.length ? result.per_frame_err : [], [result]);

  const predictedA = useMemo(() => {
    if (!result?.ok || !result.T || !vizB.length) return [];
    const Xi = invT(result.T);
    const offset = applyT(Xi, [0, 0, 0]);
    return vizB.map(s => applyT(s.T, offset));
  }, [result, vizB]);

  const vpW = 900, vpH = 620;
  const pts = (arr) => arr.map(s => applyT(s.T, [0, 0, 0]));
  const readyA = slotReady(slotA);
  const readyB = slotReady(slotB);

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>Link · A ↔ B</span>
          <span className="mono" style={{color: (readyA && readyB) ? 'var(--ok)' : 'var(--text-4)'}}>
            {readyA && readyB ? '● both ready' : '○ slot pending'}
          </span>
        </div>
        <div className="rail-scroll">
          <SlotCard
            label="A" slot={slotA} setSlot={setSlotA}
            setWantConnected={setWantA}
            buf={slotsBufA}
            onStartRec={() => startRec(slotA, setSlotA, slotsBufA)}
            onStopRec={() => stopAndSaveRec(slotA, setSlotA, slotsBufA, 'A')}
            onImportFile={() => importFile(slotA, setSlotA, 'A')}
            onImportMcapTopic={() => importMcapTopic(slotA, setSlotA, 'A')}
            onFlipMode={(mode) => flipMode(setSlotA, setWantA, mode)}
          />
          <SlotCard
            label="B" slot={slotB} setSlot={setSlotB}
            setWantConnected={setWantB}
            buf={slotsBufB}
            onStartRec={() => startRec(slotB, setSlotB, slotsBufB)}
            onStopRec={() => stopAndSaveRec(slotB, setSlotB, slotsBufB, 'B')}
            onImportFile={() => importFile(slotB, setSlotB, 'B')}
            onImportMcapTopic={() => importMcapTopic(slotB, setSlotB, 'B')}
            onFlipMode={(mode) => flipMode(setSlotB, setWantB, mode)}
          />

          <Section title="Mapping" hint={`${slotA.device || '—'} → ${slotB.device || '—'}`}>
            <Field label="link label">
              <input className="input" value={linkLabel}
                     onChange={e => setLinkLabel(e.target.value)}/>
            </Field>
          </Section>

          <Section title="Sync" hint={
            syncDiag ? `${syncDiag.n_pairs} pairs · Δt ${syncDiag.delta_t.toFixed(3)}s`
            : syncEst ? `est Δt ${syncEst.delta_t.toFixed(3)}s · tune & apply`
            : 'not synced'}>
            <button className="btn" onClick={onEstimate} disabled={!(readyA && readyB)}>
              ⚡ estimate Δt
            </button>
            {syncEst && (
              <>
                <Field label="Δt (s)">
                  <div style={{ display:'flex', gap: 4 }}>
                    <input
                      type="number" step="0.001"
                      className="input"
                      style={{ flex: 1 }}
                      value={Number.isFinite(deltaT) ? deltaT : ''}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        setDeltaT(Number.isFinite(v) ? v : null);
                      }}/>
                    {Number.isFinite(deltaT) && deltaT !== syncEst.delta_t && (
                      <button className="btn ghost" title="reset to estimate"
                              onClick={() => setDeltaT(syncEst.delta_t)}>↺</button>
                    )}
                  </div>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)',
                    display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                  <span>estimate</span><span>{syncEst.delta_t.toFixed(3)} s · SNR {syncEst.snr.toFixed(2)}</span>
                  <span>A rot</span><span>{syncEst.a_rot_deg.toFixed(1)}°</span>
                  <span>B rot</span><span>{syncEst.b_rot_deg.toFixed(1)}°</span>
                </div>
                <button className="btn primary" onClick={onApply}
                        disabled={!Number.isFinite(deltaT)}>
                  ✓ apply &amp; pair
                </button>
              </>
            )}
            {syncDiag && (
              <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)',
                  display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                <span>locked Δt</span><span>{syncDiag.delta_t.toFixed(3)} s</span>
                <span>pairs</span><span>{syncDiag.n_pairs}</span>
              </div>
            )}
          </Section>

          <Section title="Solve" hint={solveGate ? 'gated' : `${solvePattern.replace('_', '-')} · ready`}>
            <Field label="method">
              <select className="select" value={solveMethod}
                      onChange={e => setSolveMethod(e.target.value)}>
                <option value="daniilidis">daniilidis</option>
                <option value="tsai">tsai</option>
                <option value="park">park</option>
                <option value="horaud">horaud</option>
                <option value="andreff">andreff</option>
              </select>
            </Field>
            <button className="btn primary" onClick={onSolve}
                    disabled={!!solveGate || busy} title={solveGate || ''}>
              ▶ Solve T_{linkLabel}
            </button>
            {solveGate && <div className="mono" style={{ fontSize: 10.5, color:'var(--warn)' }}>{solveGate}</div>}
          </Section>

          {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', padding: '0 2px' }}>{status}</div>}
        </div>
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
            onClick={() => setShowAfter(v => !v)}>
            {showAfter ? '◉' : '○'} after extrinsics
          </button>
          <div className="spacer"/>
          <div className="read">
            {result?.ok
              ? <>‖t‖ <b>{tNorm.toFixed(2)} mm</b> · rot rms <b>{rotRms.toFixed(3)}°</b> · trans rms <b>{transRms.toFixed(2)} mm</b></>
              : <>{readyA && readyB ? 'awaiting sync/solve' : 'configure both slots'}</>}
          </div>
        </div>
        <div className="vp-body" style={{ gridTemplateColumns: '1fr', gap: 1, background: 'var(--view-border)' }}>
          <div className="vp-cell">
            <span className="vp-label">world</span>
            <Scene3D w={vpW} h={vpH}>
              {(cam) => (
                <g>
                  {showGround && <Ground3D cam={cam} size={0.6} step={0.05} z={-0.12}/>}
                  {showTraj && vizA.length > 1 && (
                    <Traj3D points={pts(vizA)} cam={cam} color="#ffa95a" dotEvery={8}/>
                  )}
                  {showTraj && vizB.length > 1 && (
                    <Traj3D points={pts(vizB)} cam={cam} color="#b78cff" dotEvery={8}/>
                  )}
                  {showAfter && predictedA.length > 1 && (
                    <Traj3D points={predictedA} cam={cam} color="#7fffbf" dotEvery={8}/>
                  )}
                  {curA && <Tracker3D    T={curA} cam={cam} label={slotA.device}/>}
                  {curB && <Controller3D T={curB} cam={cam} label={slotB.device}/>}
                  {showLink && curA && curB && (
                    <RigidLink3D
                      a={applyT(curA, [0,0,0])}
                      b={applyT(curB, [0,0,0])}
                      cam={cam} color="#e3bd56"/>
                  )}
                </g>
              )}
            </Scene3D>
          </div>
        </div>
      </div>

      <div className="rail">
        <div className="rail-header">
          <span>Results · T_{linkLabel}</span>
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

// ──────────────────────────────────────────────────────────────────────────────
// SlotCard — one card per source slot.

function SlotCard({
  label, slot, setSlot, setWantConnected, buf,
  onStartRec, onStopRec, onImportFile, onImportMcapTopic, onFlipMode,
}) {
  const ready = slotReady(slot);
  const liveCount = slot.recording ? buf.rec.length : 0;
  const importHint = slot.importMeta
    ? `n=${slot.importMeta.n} · Δ${(slot.importMeta.t_last - slot.importMeta.t_first).toFixed(1)}s`
    : 'no file loaded';

  return (
    <Section title={`Source ${label}`} hint={ready ? '✓ ready' : slot.mode}>
      <Seg value={slot.mode} onChange={onFlipMode} full options={[
        {value:'live',   label:'● live'},
        {value:'import', label:'↓ import'},
      ]}/>

      {slot.mode === 'live' && (
        <>
          <Field label="backend">
            <select className="select" value={slot.backend} disabled={slot.connected}
                    onChange={e => setSlot(s => ({ ...s, backend: e.target.value }))}>
              <option value="oculus">oculus (Quest3s)</option>
              <option value="steamvr">steamvr (Vive tracker)</option>
            </select>
          </Field>
          {slot.backend === 'oculus' && (
            <Field label="adb ip">
              <input className="input" placeholder="(blank = USB)" value={slot.adbIp}
                     disabled={slot.connected}
                     onChange={e => setSlot(s => ({ ...s, adbIp: e.target.value }))}/>
            </Field>
          )}
          <Field label="fps">
            <input type="number" className="input" value={slot.fps} min={1} max={120}
                   onChange={e => setSlot(s => ({ ...s, fps: +e.target.value || 30 }))}/>
          </Field>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
            {!slot.connected
              ? <button className="btn primary" onClick={() => setWantConnected(true)}>⚡ connect</button>
              : <button className="btn ghost" onClick={() => setWantConnected(false)}>⨯ disconnect</button>}
            {slot.connected && (
              slot.recording
                ? <button className="btn primary" onClick={onStopRec}>⏹ stop & save</button>
                : <button className="btn" onClick={onStartRec}>● record</button>
            )}
          </div>
          {slot.recording && <div className="mono" style={{ fontSize: 10.5 }}>{liveCount} samples buffered</div>}
          {slot.recordedPath && (
            <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>
              saved: {slot.recordedPath.split('/').pop()} ({slot.recCount})
            </div>
          )}
        </>
      )}

      {slot.mode === 'import' && (
        <>
          <Field label="format">
            <Seg value={slot.format} onChange={(v) => setSlot(s => ({
              ...s, format: v, filePath: null, importedPath: null,
              mcapTopics: [], mcapTopic: null, importMeta: null, devices: [], device: null,
            }))} full options={[
              {value:'json', label:'json'},
              {value:'yaml', label:'yaml'},
              {value:'mcap', label:'mcap'},
            ]}/>
          </Field>
          <button className="btn" onClick={onImportFile}>↓ pick {slot.format}…</button>
          {slot.format === 'mcap' && slot.mcapTopics.length > 0 && (
            <>
              <Field label="topic">
                <select className="select" value={slot.mcapTopic ?? ''}
                        onChange={e => setSlot(s => ({ ...s, mcapTopic: e.target.value }))}>
                  {slot.mcapTopics.map(t => (
                    <option key={t.topic} value={t.topic}>{t.topic} ({t.n})</option>
                  ))}
                </select>
              </Field>
              <button className="btn" onClick={onImportMcapTopic} disabled={!slot.mcapTopic}>
                import topic →
              </button>
            </>
          )}
          <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>{importHint}</div>
        </>
      )}

      <Field label="device">
        <select className="select" value={slot.device ?? ''}
                disabled={slot.devices.length === 0}
                onChange={e => setSlot(s => ({ ...s, device: e.target.value }))}>
          {slot.devices.length === 0 && <option value="">(none)</option>}
          {slot.devices.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </Field>
    </Section>
  );
}
