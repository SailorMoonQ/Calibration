import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import {
  Scene3D, Tracker3D, Controller3D, Traj3D, RigidLink3D, Ground3D,
} from '../components/scene3d.jsx';
import { ErrorPanel, SolverPanel, trafficKindForRms, trafficColor } from '../components/panels.jsx';
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

// Compact local-time stamp (YYYYMMDD_HHMMSS) for the default capture session.
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
       + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function LinkCalibTab({ solvePattern }) {
  const { t } = useTranslation();
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
  const [solveResults, setSolveResults] = useState(null);  // [{method, ok, rot_rms, pos_rms, score, ...}] | null
  const [bestMethod, setBestMethod] = useState(null);
  const [viewMethod, setViewMethod] = useState(null);      // method whose result is shown
  const [tickCount, setTickCount] = useState(0);
  const [session, setSession] = useState(() => `link_${nowStamp()}`);
  const [captureState, setCaptureState] = useState('idle'); // 'idle' | 'arming' | 'recording'
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

  // A source erroring (e.g. connect failure) aborts the unified capture.
  const onSlotError = useCallback((label, msg) => {
    setStatus(t('link.slotError', { label, message: msg }));
    setCaptureState('idle');
    setSlotA(s => (s.recording ? { ...s, recording: false } : s));
    setSlotB(s => (s.recording ? { ...s, recording: false } : s));
  }, [t]);

  useSlotWs({
    slot: slotA, setSlot: setSlotA, wantConnected: wantA, setWantConnected: setWantA,
    onSample: handleSampleA,
    onError: (msg) => onSlotError('A', msg),
  });
  useSlotWs({
    slot: slotB, setSlot: setSlotB, wantConnected: wantB, setWantConnected: setWantB,
    onSample: handleSampleB,
    onError: (msg) => onSlotError('B', msg),
  });

  // Unified capture -----------------------------------------------------------
  // One Record button drives every live slot: arm → connect → record in
  // lockstep → stop → auto-save the pair into dataset/<session>/.

  const stopCapture = useCallback(async () => {
    setCaptureState('idle');
    setSlotA(s => (s.recording ? { ...s, recording: false } : s));
    setSlotB(s => (s.recording ? { ...s, recording: false } : s));
    setStatus(t('link.savingDots'));

    const slots = [];
    if (slotA.mode === 'live') slots.push(['A', setSlotA, slotsBufA]);
    if (slotB.mode === 'live') slots.push(['B', setSlotB, slotsBufB]);

    let resolved = session;
    let claimed = false;   // the first non-empty save claims a fresh folder
    const parts = [];
    for (const [label, setSlot, buf] of slots) {
      const samples = buf.rec.slice();
      if (samples.length === 0) { parts.push(t('link.empty', { label })); continue; }
      try {
        const r = await recording.save({
          kind: 'vive', samples,
          session: resolved, name: `${label}_recording`, unique: !claimed,
        });
        resolved = r.session;   // paired slot writes into the same folder
        claimed = true;
        setSlot(s => ({ ...s, recordedPath: r.path, recCount: r.n }));
        parts.push(t('link.slotSaved', { label, count: r.n }));
      } catch (e) { parts.push(t('link.slotFailed', { label, error: e.message })); }
    }
    setStatus(claimed
      ? t('link.savedTo', { session: resolved, parts: parts.join(' · ') })
      : t('link.nothingRecorded', { parts: parts.join(' · ') }));
  }, [slotA, slotB, session, slotsBufA, slotsBufB, t]);

  const onRecord = useCallback(() => {
    if (captureState === 'recording') { stopCapture(); return; }
    if (captureState === 'arming') { setCaptureState('idle'); setStatus(t('link.recordCancelled')); return; }
    const liveA = slotA.mode === 'live';
    const liveB = slotB.mode === 'live';
    if (!liveA && !liveB) { setStatus(t('link.noLiveSource')); return; }
    if (liveA) setWantA(true);
    if (liveB) setWantB(true);
    setResult(null);
    setCaptureState('arming');
    setStatus(t('link.connecting'));
  }, [captureState, slotA, slotB, stopCapture, t]);

  // Arming → recording: once every live slot is connected with a device
  // selected, start recording them together in lockstep. The setState calls
  // advance the capture state machine when the async WS connect finally
  // resolves — there is no render-time value to derive this from.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional state-machine transition */
  useEffect(() => {
    if (captureState !== 'arming') return;
    const live = [];
    if (slotA.mode === 'live') live.push(slotA);
    if (slotB.mode === 'live') live.push(slotB);
    if (live.length === 0) { setCaptureState('idle'); return; }
    if (!live.every(s => s.connected && s.device)) return;   // still coming up
    if (slotA.mode === 'live') {
      slotsBufA.rec.length = 0;
      setSlotA(s => ({ ...s, recording: true, recordedPath: null, recCount: 0 }));
    }
    if (slotB.mode === 'live') {
      slotsBufB.rec.length = 0;
      setSlotB(s => ({ ...s, recording: true, recordedPath: null, recCount: 0 }));
    }
    setCaptureState('recording');
    setStatus(t('link.recording'));
  }, [captureState, slotA, slotB, slotsBufA, slotsBufB, t]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
    setStatus(t('link.loadingDots', { label }));
    try {
      if (slot.format === 'mcap') {
        const tp = await recording.listTopics(path);
        const topics = tp.topics || [];
        if (topics.length === 0) { setStatus(t('link.noPoseTopics', { label })); return; }
        setSlot(s => ({ ...s, mcapTopics: topics, mcapTopic: topics[0].topic }));
        setStatus(t('link.topicsPickOne', { label, count: topics.length }));
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
        setStatus(t('link.loadedSamples', { label, count: r.count, span: (r.t_last - r.t_first).toFixed(1) }));
      }
    } catch (e) { setStatus(t('link.importFailed', { label, error: e.message })); }
  };

  const importMcapTopic = async (slot, setSlot, label) => {
    if (!slot.filePath || !slot.mcapTopic) return;
    const out_path = await pickSaveFile({ defaultPath: `${label}_umi.json` });
    if (!out_path) return;
    setStatus(t('link.importingTopic', { label, topic: slot.mcapTopic }));
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
      setStatus(t('link.importedSamples', { label, count: r.count, span: (r.t_last - r.t_first).toFixed(1) }));
    } catch (e) { setStatus(t('link.importFailed', { label, error: e.message })); }
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
    if (!a || !b) { setStatus(t('link.bothSlotsReady')); return; }
    setStatus(t('link.estimatingDt'));
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
      setStatus(t('link.estimateResult', { dt: est.delta_t.toFixed(3), snr: est.snr.toFixed(2) }));
    } catch (e) { setStatus(t('link.estimateFailed', { error: e.message })); }
  }, [slotA, slotB, t]);

  const onApply = useCallback(async () => {
    const a = slotPath(slotA);
    const b = slotPath(slotB);
    if (!a || !b) { setStatus(t('link.bothSlotsReady')); return; }
    if (!Number.isFinite(deltaT)) { setStatus(t('link.dtMustBeNumber')); return; }
    const out_path = await pickSaveFile({ defaultPath: `synced_${linkLabel}.json` });
    if (!out_path) return;
    setStatus(t('link.pairingDots'));
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
      setStatus(t('link.pairedResult', { dt: r.delta_t.toFixed(3), pairs: r.n_pairs }));
    } catch (e) { setStatus(t('link.applyFailed', { error: e.message })); }
  }, [slotA, slotB, deltaT, linkLabel, t]);

  const onSolve = useCallback(async () => {
    if (!syncPath) { setStatus(t('link.syncFirst')); return; }
    setBusy(true); setStatus(t('link.solvingAllMethods'));
    try {
      const r = await recording.calibrateHandeyePoseAll({
        synced_path: syncPath, pattern: solvePattern,
      });
      if (!r.ok || !r.results?.length) {
        setSolveResults(null); setResult(null);
        setStatus(t('link.solveFailedAll'));
        return;
      }
      setSolveResults(r.results);
      setBestMethod(r.best);
      setViewMethod(r.best);
      const top = r.results.find(x => x.method === r.best);
      setResult(top);
      setStatus(t('link.solveResult', { label: linkLabel, method: r.best, rot: top.rot_rms.toFixed(2), trans: top.pos_rms.toFixed(1) }));
    } catch (e) { setStatus(t('link.solveFailed', { error: e.message })); }
    finally { setBusy(false); }
  }, [syncPath, solvePattern, linkLabel, t]);

  // Switch which solved method the Results panel shows.
  const selectMethod = useCallback((m) => {
    setViewMethod(m);
    const r = solveResults?.find(x => x.method === m);
    if (r?.ok) setResult(r);
  }, [solveResults]);

  const onSaveYaml = useCallback(async () => {
    if (!result?.ok) { setStatus(t('link.nothingToSaveSolve')); return; }
    const p = await pickSaveFile({ defaultPath: `link_${linkLabel}.yaml` });
    if (!p) return;
    try {
      await api.saveCalibration({ path: p, kind: 'chain', result });
      setStatus(t('common.saved', { path: p }));
    } catch (e) { setStatus(t('common.saveFailed', { error: e.message })); }
  }, [result, linkLabel, t]);

  const onLoadYaml = useCallback(async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      setResult({
        ok: true, rms: d.rms ?? 0,
        rot_rms: d.rot_rms ?? d.rms ?? 0,
        pos_rms: d.pos_rms ?? 0,
        T: d.T || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0, message: `loaded from ${p}`,
      });
      setSolveResults(null);
      setStatus(t('common.loaded', { path: p }));
    } catch (e) { setStatus(t('common.loadFailed', { error: e.message })); }
  }, [t]);

  const solveGate = (() => {
    if (!syncDiag) return t('link.runSyncFirst');
    if (syncDiag.n_pairs < 50) return t('link.onlyPairs', { pairs: syncDiag.n_pairs });
    if (syncDiag.a_rot_deg < 30) return t('link.aRotLow', { deg: syncDiag.a_rot_deg.toFixed(1) });
    if (syncDiag.b_rot_deg < 30) return t('link.bRotLow', { deg: syncDiag.b_rot_deg.toFixed(1) });
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

  // Wipe the on-screen trajectory polylines for both slots. Recorded samples
  // (buf.rec) are left untouched; the polyline rebuilds as new samples arrive.
  // Gated to non-recording state so the view always matches the live capture.
  const isRecording = slotA.recording || slotB.recording;
  const clearTraj = useCallback(() => {
    slotsBufA.viz.length = 0;
    slotsBufB.viz.length = 0;
    setTickCount(n => n + 1);
  }, [slotsBufA, slotsBufB]);

  const recCount = captureState === 'recording'
    ? Math.max(slotsBufA.rec.length, slotsBufB.rec.length)
    : 0;

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
  const rotRms = result?.ok ? (result.rot_rms ?? result.rms ?? 0) : 0;
  const transRms = result?.ok ? (result.pos_rms ?? 0) : 0;
  // Traffic-light thresholds for link calibration: rotation in degrees,
  // translation in millimetres.
  const LINK_ROT_OK = 0.5, LINK_ROT_WARN = 1.0;
  const LINK_TRANS_OK = 2.0, LINK_TRANS_WARN = 5.0;
  const rotKind = result?.ok ? trafficKindForRms(rotRms, LINK_ROT_OK, LINK_ROT_WARN) : 'idle';
  const transKind = result?.ok ? trafficKindForRms(transRms, LINK_TRANS_OK, LINK_TRANS_WARN) : 'idle';
  const overallKind = result?.ok
    ? (rotKind === 'err' || transKind === 'err' ? 'err'
      : rotKind === 'warn' || transKind === 'warn' ? 'warn' : 'ok')
    : 'idle';
  const overallColor = trafficColor(overallKind);

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
          <span>{t('link.railTitle')}</span>
          <span className="mono" style={{color: (readyA && readyB) ? 'var(--ok)' : 'var(--text-4)'}}>
            {readyA && readyB ? t('link.bothReady') : t('link.slotPending')}
          </span>
        </div>
        <div className="rail-scroll">
          <SlotCard
            label="A" slot={slotA} setSlot={setSlotA}
            setWantConnected={setWantA}
            buf={slotsBufA}
            onImportFile={() => importFile(slotA, setSlotA, 'A')}
            onImportMcapTopic={() => importMcapTopic(slotA, setSlotA, 'A')}
            onFlipMode={(mode) => flipMode(setSlotA, setWantA, mode)}
          />
          <SlotCard
            label="B" slot={slotB} setSlot={setSlotB}
            setWantConnected={setWantB}
            buf={slotsBufB}
            onImportFile={() => importFile(slotB, setSlotB, 'B')}
            onImportMcapTopic={() => importMcapTopic(slotB, setSlotB, 'B')}
            onFlipMode={(mode) => flipMode(setSlotB, setWantB, mode)}
          />

          <Section title={t('link.capture')} hint={
            captureState === 'recording' ? t('link.recPrefix', { count: recCount })
            : captureState === 'arming' ? t('link.connecting')
            : t('common.idle')}>
            <Field label={t('link.session')}>
              <input className="input" value={session}
                     disabled={captureState !== 'idle'}
                     onChange={e => setSession(e.target.value)}/>
            </Field>
            <button
              className={`btn ${captureState === 'recording' ? 'primary' : ''}`}
              style={{ width: '100%' }}
              onClick={onRecord}
              disabled={slotA.mode !== 'live' && slotB.mode !== 'live'}>
              {captureState === 'recording' ? t('link.stopAndSave', { count: recCount })
               : captureState === 'arming' ? t('link.connectingCancel')
               : t('link.recordAll')}
            </button>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
              → dataset/{session || '…'}/
            </div>
          </Section>

          <Section title={t('link.mapping')} hint={`${slotA.device || '—'} → ${slotB.device || '—'}`}>
            <Field label={t('link.linkLabel')}>
              <input className="input" value={linkLabel}
                     onChange={e => setLinkLabel(e.target.value)}/>
            </Field>
          </Section>

          <Section title={t('link.sync')} hint={
            syncDiag ? t('link.syncedPairs', { pairs: syncDiag.n_pairs, dt: syncDiag.delta_t.toFixed(3) })
            : syncEst ? t('link.estTune', { dt: syncEst.delta_t.toFixed(3) })
            : t('link.notSynced')}>
            <button className="btn" onClick={onEstimate} disabled={!(readyA && readyB)}>
              {t('link.estimateDt')}
            </button>
            {syncEst && (
              <>
                <Field label={t('link.dtSeconds')}>
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
                      <button className="btn ghost" title={t('link.resetToEstimate')}
                              onClick={() => setDeltaT(syncEst.delta_t)}>↺</button>
                    )}
                  </div>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)',
                    display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                  <span>{t('link.estimate')}</span><span>{t('link.estimateValue', { dt: syncEst.delta_t.toFixed(3), snr: syncEst.snr.toFixed(2) })}</span>
                  <span>{t('link.aRot')}</span><span>{syncEst.a_rot_deg.toFixed(1)}°</span>
                  <span>{t('link.bRot')}</span><span>{syncEst.b_rot_deg.toFixed(1)}°</span>
                </div>
                <button className="btn primary" onClick={onApply}
                        disabled={!Number.isFinite(deltaT)}>
                  {t('link.applyPair')}
                </button>
              </>
            )}
            {syncDiag && (
              <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)',
                  display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
                <span>{t('link.lockedDt')}</span><span>{t('link.lockedDtValue', { dt: syncDiag.delta_t.toFixed(3) })}</span>
                <span>{t('link.pairs')}</span><span>{syncDiag.n_pairs}</span>
              </div>
            )}
          </Section>

          <Section title={t('link.solve')} hint={
            solveResults ? t('link.best', { method: bestMethod })
            : solveGate ? t('link.gated')
            : t('link.ready', { pattern: solvePattern.replace('_', '-') })}>
            <button className="btn primary" style={{ width: '100%' }} onClick={onSolve}
                    disabled={!!solveGate || busy} title={solveGate || ''}>
              {busy ? t('link.solvingAll') : solveResults ? t('link.resolveAll') : t('link.solveT', { label: linkLabel })}
            </button>
            {solveGate && <div className="mono" style={{ fontSize: 10.5, color:'var(--warn)' }}>{solveGate}</div>}
            {solveResults && (
              <>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', margin: '2px 0' }}>
                  {t('link.fiveMethods')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {solveResults.map(r => {
                    const isBest = r.method === bestMethod;
                    const isView = r.method === viewMethod;
                    const rk = r.ok ? trafficKindForRms(r.rot_rms, LINK_ROT_OK, LINK_ROT_WARN) : 'idle';
                    const tk = r.ok ? trafficKindForRms(r.pos_rms, LINK_TRANS_OK, LINK_TRANS_WARN) : 'idle';
                    return (
                      <button
                        key={r.method}
                        className={`btn ${isView ? 'primary' : 'ghost'}`}
                        disabled={!r.ok}
                        onClick={() => selectMethod(r.method)}
                        style={{ display: 'flex', justifyContent: 'space-between', gap: 8,
                                 fontSize: 10.5, padding: '3px 7px' }}>
                        <span>{isBest ? '★ ' : ''}{r.method}</span>
                        <span className="mono">
                          {r.ok ? (
                            <>
                              <span style={{ color: trafficColor(rk) }}>{r.rot_rms.toFixed(2)}°</span>
                              {' / '}
                              <span style={{ color: trafficColor(tk) }}>{r.pos_rms.toFixed(1)} mm</span>
                            </>
                          ) : t('link.methodFailed')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </Section>

          {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', padding: '0 2px' }}>{status}</div>}
        </div>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value="scene" onChange={()=>{}} options={[{value:'scene',label:t('link.scene3d')}]}/>
          <Chk checked={showTraj} onChange={setShowTraj}>{t('link.trajectories')}</Chk>
          <Chk checked={showLink} onChange={setShowLink}>{t('link.rigidLink')}</Chk>
          <Chk checked={showGround} onChange={setShowGround}>{t('link.groundGrid')}</Chk>
          <button
            className="btn ghost"
            onClick={clearTraj}
            disabled={isRecording}
            title={isRecording
              ? t('link.clearTrajWhileRecording')
              : t('link.clearTrajHint')}>
            {t('link.clearTraj')}
          </button>
          <button
            className={`btn ${showAfter ? 'primary' : 'ghost'}`}
            disabled={!result?.ok}
            onClick={() => setShowAfter(v => !v)}>
            {showAfter ? '◉' : '○'} {t('link.afterExtrinsics')}
          </button>
          <div className="spacer"/>
          <div className="read">
            {result?.ok
              ? <>‖t‖ <b>{tNorm.toFixed(2)} mm</b> · rot rms <b style={{color: trafficColor(rotKind)}}>{rotRms.toFixed(3)}°</b> · trans rms <b style={{color: trafficColor(transKind)}}>{transRms.toFixed(2)} mm</b></>
              : <>{readyA && readyB ? t('link.awaitingSyncSolve') : t('link.configureBothSlots')}</>}
          </div>
        </div>
        <div className="vp-body" style={{ gridTemplateColumns: '1fr', gap: 1, background: 'var(--view-border)' }}>
          <div className="vp-cell">
            <span className="vp-label">{t('link.world')}</span>
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
          <span>{t('link.resultsPrefix', { label: linkLabel })}</span>
          <span className="mono" style={{color: result?.ok ? overallColor : 'var(--text-4)'}}>
            {result?.ok ? `● ${transRms.toFixed(2)} mm` : busy ? t('common.solvingDot') : t('common.idleDot')}
          </span>
        </div>
        <div className="rail-scroll">
          <Section title={t('link.tLabel', { label: linkLabel })}>
            <Matrix m={Tmat}/>
            <KV items={[
              ['t (mm)',  `[ ${tMm[0].toFixed(2)}, ${tMm[1].toFixed(2)}, ${tMm[2].toFixed(2)} ]`, ''],
              ['rpy (°)', `[ ${rpy[0].toFixed(3)}, ${rpy[1].toFixed(3)}, ${rpy[2].toFixed(3)} ]`, ''],
              ['||t||',   `${tNorm.toFixed(2)} mm`, 'pos'],
            ]}/>
          </Section>
          <Section title={t('link.residuals')} hint={t('link.residualsHint')}>
            <KV items={[
              [t('link.rotRms'),  `${rotRms.toFixed(4)}°`,    result?.ok ? (rotKind === 'ok' ? 'pos' : rotKind) : ''],
              [t('link.transRms'),`${transRms.toFixed(3)} mm`, result?.ok ? (transKind === 'ok' ? 'pos' : transKind) : ''],
            ]}/>
          </Section>
          {histData.length > 0 && (
            <ErrorPanel
              rms={transRms} frames={histData.slice(0, 60)} histData={histData}
              title={t('link.translationError')} unit="mm"
              okBelow={LINK_TRANS_OK} warnBelow={LINK_TRANS_WARN}/>
          )}
          <SolverPanel iters={result?.iterations || 0}
            cost={transRms} costUnit="mm" costLabel={t('link.transRms')}
            cond={0}
            algo={t('link.solverAlgo')}/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoadYaml}>{t('common.load')}</button>
          <button className="btn primary" style={{flex:1}} onClick={onSaveYaml} disabled={!result?.ok}>{t('common.saveYaml')}</button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// SlotCard — one card per source slot.

function SlotCard({
  label, slot, setSlot, setWantConnected, buf,
  onImportFile, onImportMcapTopic, onFlipMode,
}) {
  const { t } = useTranslation();
  const ready = slotReady(slot);
  const liveCount = slot.recording ? buf.rec.length : 0;
  const importHint = slot.importMeta
    ? t('link.importMeta', { n: slot.importMeta.n, span: (slot.importMeta.t_last - slot.importMeta.t_first).toFixed(1) })
    : t('link.noFileLoaded');

  return (
    <Section title={t('link.sourceLabel', { label })} hint={ready ? t('link.slotReadyTag') : slot.mode}>
      <Seg value={slot.mode} onChange={onFlipMode} full options={[
        {value:'live',   label:t('link.slotLive')},
        {value:'import', label:t('link.slotImport')},
      ]}/>

      {slot.mode === 'live' && (
        <>
          <Field label={t('link.backend')}>
            <select className="select" value={slot.backend} disabled={slot.connected}
                    onChange={e => setSlot(s => ({ ...s, backend: e.target.value }))}>
              <option value="oculus">{t('link.backendOculus')}</option>
              <option value="pico">{t('link.backendPico')}</option>
              <option value="steamvr">{t('link.backendSteamvr')}</option>
            </select>
          </Field>
          {slot.backend === 'oculus' && (
            <Field label={t('link.adbIp')}>
              <input className="input" placeholder={t('link.adbIpPlaceholder')} value={slot.adbIp}
                     disabled={slot.connected}
                     onChange={e => setSlot(s => ({ ...s, adbIp: e.target.value }))}/>
            </Field>
          )}
          <Field label={t('link.fps')}>
            <input type="number" className="input" value={slot.fps} min={1} max={120}
                   onChange={e => setSlot(s => ({ ...s, fps: +e.target.value || 30 }))}/>
          </Field>
          {!slot.connected
            ? <button className="btn primary" style={{ width: '100%' }}
                      onClick={() => setWantConnected(true)}>{t('link.connect')}</button>
            : <button className="btn ghost" style={{ width: '100%' }}
                      onClick={() => setWantConnected(false)}>{t('link.disconnect')}</button>}
          {slot.recording && <div className="mono" style={{ fontSize: 10.5 }}>{t('link.samplesBuffered', { count: liveCount })}</div>}
          {slot.recordedPath && (
            <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>
              {t('link.savedSlot', { name: slot.recordedPath.split('/').pop(), count: slot.recCount })}
            </div>
          )}
        </>
      )}

      {slot.mode === 'import' && (
        <>
          <Field label={t('link.format')}>
            <Seg value={slot.format} onChange={(v) => setSlot(s => ({
              ...s, format: v, filePath: null, importedPath: null,
              mcapTopics: [], mcapTopic: null, importMeta: null, devices: [], device: null,
            }))} full options={[
              {value:'json', label:'json'},
              {value:'yaml', label:'yaml'},
              {value:'mcap', label:'mcap'},
            ]}/>
          </Field>
          <button className="btn" onClick={onImportFile}>{t('link.pickFormat', { format: slot.format })}</button>
          {slot.format === 'mcap' && slot.mcapTopics.length > 0 && (
            <>
              <Field label={t('link.topic')}>
                <select className="select" value={slot.mcapTopic ?? ''}
                        onChange={e => setSlot(s => ({ ...s, mcapTopic: e.target.value }))}>
                  {slot.mcapTopics.map(tp => (
                    <option key={tp.topic} value={tp.topic}>{tp.topic} ({tp.n})</option>
                  ))}
                </select>
              </Field>
              <button className="btn" onClick={onImportMcapTopic} disabled={!slot.mcapTopic}>
                {t('link.importTopic')}
              </button>
            </>
          )}
          <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>{importHint}</div>
        </>
      )}

      <Field label={t('cameraSource.device')}>
        <select className="select" value={slot.device ?? ''}
                disabled={slot.devices.length === 0}
                onChange={e => setSlot(s => ({ ...s, device: e.target.value }))}>
          {slot.devices.length === 0 && <option value="">{t('link.deviceNone')}</option>}
          {slot.devices.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </Field>
    </Section>
  );
}
