import React, { useState, useMemo, useEffect } from 'react';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import { CameraView, ChessboardOverlay } from '../components/viewport.jsx';
import {
  Scene3D, Frustum3D, Controller3D, Tracker3D, Gripper3D, Traj3D, RigidLink3D,
} from '../components/scene3d.jsx';
import {
  FrameStrip, ErrorPanel, SourcePanel,
  CaptureControls, SolverButton, SolverPanel,
} from '../components/panels.jsx';
import { makeT, applyT, composeT } from '../lib/math3d.js';
import { genFrames, gridCells } from '../lib/mock.js';
import { api, pickSaveFile, pickOpenFile } from '../api/client.js';

const basename = (p) => (p || '').split('/').pop();

const LINK_PRESETS = [
  { id: 'ctrl_tracker',   label: 'ctrl → tracker',    from: 'controller', to: 'tracker', fromColor: '#b78cff', toColor: '#ffa95a' },
  { id: 'tracker_gripper',label: 'tracker → gripper', from: 'tracker',    to: 'gripper', fromColor: '#ffa95a', toColor: '#ffd77a' },
  { id: 'ctrl_gripper',   label: 'ctrl → gripper',    from: 'controller', to: 'gripper', fromColor: '#b78cff', toColor: '#ffd77a' },
];

export function ChainTab() {
  const [live, setLive] = useState(true);
  const [bagPath, setBagPath] = useState('~/datasets/chain.mcap');
  const [device, setDevice] = useState('/camera/image_raw · Basler acA1920');
  const [activeLink, setActiveLink] = useState('ctrl_tracker');
  const [showGripperInCam, setGIC] = useState(true);
  const [showWireframe, setWire] = useState(true);
  const [showChain, setChain] = useState(true);
  const [showTraj, setTraj] = useState(true);

  // per-link state: each preset has its own file paths + result.
  const [linkState, setLinkState] = useState(() => {
    const init = {};
    LINK_PRESETS.forEach(l => { init[l.id] = { pathA: '', pathB: '', result: null }; });
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const current = linkState[activeLink];
  const activePreset = LINK_PRESETS.find(l => l.id === activeLink);
  const result = current.result;

  const mockFrames = useMemo(() => genFrames(30, 0.28), []);
  const mockPoses = useMemo(() => Array.from({ length: 44 }, (_, i) => {
    const t = i / 44;
    return makeT(0.4*Math.sin(t*6), -Math.PI/2 + 0.7*Math.cos(t*3.5), 0.3*Math.sin(t*4),
                 -0.08 + 0.18*Math.sin(t*Math.PI*2.5),
                  0.03 + 0.08*Math.cos(t*Math.PI*3),
                  0.04 + 0.07*Math.sin(t*Math.PI*2));
  }), []);

  const errByPath = useMemo(() => {
    if (!result?.ok) return null;
    const m = new Map();
    (result.detected_paths || []).forEach((n, i) => m.set(n, result.per_frame_err?.[i] ?? 0));
    return m;
  }, [result]);

  const realFrames = useMemo(() => {
    if (!result?.detected_paths?.length) return null;
    return result.detected_paths.map((n, i) => ({
      id: i + 1, err: errByPath?.get(n) ?? 0, tx: 0, ty: 0, rot: 0,
    }));
  }, [result, errByPath]);

  const frames = realFrames ?? mockFrames;
  const [selected, setSelected] = useState(1);

  useEffect(() => { setSelected(1); }, [activeLink]);

  const setLink = (patch) => setLinkState(s => ({ ...s, [activeLink]: { ...s[activeLink], ...patch } }));

  const onPickA = async () => {
    const p = await pickOpenFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (p) setLink({ pathA: p });
  };
  const onPickB = async () => {
    const p = await pickOpenFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (p) setLink({ pathB: p });
  };

  const onRun = async () => {
    if (!current.pathA || !current.pathB) { setStatus('pick both A and B pose JSON files'); return; }
    setBusy(true); setStatus('averaging rigid link…');
    try {
      const res = await api.calibrate('chain', {
        poses_a_path: current.pathA,
        poses_b_path: current.pathB,
        link_label: activeLink,
      });
      setLink({ result: res });
      setStatus(res.ok
        ? `rot ${res.rms.toFixed(3)}° · trans ${res.final_cost.toFixed(2)} mm · ${res.message}`
        : `failed: ${res.message}`);
    } catch (e) { setStatus(`error: ${e.message}`); } finally { setBusy(false); }
  };

  const onSaveYaml = async () => {
    if (!result?.ok) { setStatus('nothing to save — run calibration first'); return; }
    const p = await pickSaveFile({ defaultPath: `chain_${activeLink}.yaml` });
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
      setLink({ result: {
        ok: true, rms: d.rms ?? 0,
        T: d.T || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0, message: `loaded from ${p}`,
      }});
      setStatus(`loaded ← ${p}`);
    } catch (e) { setStatus(`load failed: ${e.message}`); }
  };

  const Tmat = result?.T ?? [
    [1, 0, 0, 0.032],
    [0, 1, 0, -0.011],
    [0, 0, 1, 0.048],
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

  const rotRms = result?.ok ? result.rms : 0.0;
  const transRms = result?.ok ? result.final_cost : 0.0;

  const histData = useMemo(() => result?.per_frame_err?.length
    ? result.per_frame_err
    : Array.from({ length: 30 }, (_, i) => 0.4 + Math.abs(Math.sin(i * 0.3)) * 0.6),
  [result]);

  const vpW = 900, vpH = 620;

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header"><span>Chain · rigid link solver</span>
          <span className="mono" style={{color:'var(--text-4)'}}>
            {Object.values(linkState).filter(s => s.result?.ok).length}/{LINK_PRESETS.length} solved
          </span>
        </div>
        <div className="rail-scroll">
          <SourcePanel live={live} onLive={setLive} device={device} onDevice={setDevice}
            bagPath={bagPath} onBagPath={setBagPath}/>
          <Section title="Kinematic chain" hint="pick active link">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {LINK_PRESETS.map(l => {
                const lr = linkState[l.id].result;
                const tag = lr?.ok
                  ? `${lr.rms.toFixed(2)}° / ${lr.final_cost.toFixed(1)}mm`
                  : '—';
                return (
                  <button key={l.id}
                    onClick={() => setActiveLink(l.id)}
                    className="btn sm"
                    style={{
                      justifyContent: 'flex-start', height: 36,
                      borderColor: activeLink === l.id ? 'var(--accent)' : 'var(--border)',
                      background: activeLink === l.id ? 'var(--accent-soft)' : 'var(--surface)',
                      padding: '0 8px',
                    }}>
                    <span style={{ display:'inline-flex', alignItems:'center', gap: 6, flex: 1 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.fromColor }}/>
                      <span style={{ fontSize: 11 }}>{l.from}</span>
                      <span style={{ color: 'var(--text-4)', fontFamily: 'JetBrains Mono' }}>→</span>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.toColor }}/>
                      <span style={{ fontSize: 11 }}>{l.to}</span>
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: lr?.ok ? 'var(--ok)' : 'var(--text-4)' }}>{tag}</span>
                  </button>
                );
              })}
            </div>
          </Section>
          <Section title={`${activePreset.from} poses (A)`} hint={current.pathA ? basename(current.pathA) : 'JSON · T_base_a'}>
            <Field label="file">
              <input className="input" value={current.pathA}
                onChange={e => setLink({ pathA: e.target.value })}
                placeholder="basename → 4×4"/>
            </Field>
            <button className="btn" onClick={onPickA}>📁 pick json</button>
          </Section>
          <Section title={`${activePreset.to} poses (B)`} hint={current.pathB ? basename(current.pathB) : 'JSON · T_base_b'}>
            <Field label="file">
              <input className="input" value={current.pathB}
                onChange={e => setLink({ pathB: e.target.value })}
                placeholder="basename → 4×4"/>
            </Field>
            <button className="btn" onClick={onPickB}>📁 pick json</button>
          </Section>
          <Section title="Solver" hint="SE(3) chordal mean">
            <Chk checked={true} onChange={()=>{}}>enforce rigid link (SO(3) projection)</Chk>
            <Chk checked={false} onChange={()=>{}}>reject outliers (&gt; 3σ)</Chk>
            <Chk checked={false} onChange={()=>{}}>joint multi-link solve (TODO)</Chk>
          </Section>
          <CaptureControls live={live} onLive={setLive} autoCapture={true} onAuto={()=>{}}
            coverage={Math.min(100, (result?.iterations ?? 0) * 3)}
            coverageCells={gridCells(40, Array.from({length: Math.min(40, result?.iterations ?? 0)}, (_,i) => i))}/>
          {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', padding: '0 2px' }}>{status}</div>}
        </div>
        <SolverButton onSolve={onRun} busy={busy} label={`Calibrate ${activePreset.label}`}/>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value="scene" onChange={()=>{}} options={[{value:'scene',label:'3D scene'},{value:'cam',label:'gripper-in-cam'}]}/>
          <Chk checked={showChain} onChange={setChain}>chain links</Chk>
          <Chk checked={showTraj} onChange={setTraj}>trajectory</Chk>
          <Chk checked={showGripperInCam} onChange={setGIC}>gripper overlay</Chk>
          <Chk checked={showWireframe} onChange={setWire}>wireframe</Chk>
          <div className="spacer"/>
          <div className="read">
            {result?.ok
              ? <>chain err <b>{transRms.toFixed(2)} mm</b> · links <b>{Object.values(linkState).filter(s => s.result?.ok).length}/{LINK_PRESETS.length}</b></>
              : <>awaiting solve</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selected} onSelect={setSelected}
          coverage={Math.min(100, (result?.iterations ?? 0) * 3)}/>
        <div className="vp-body" style={{ gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--view-border)' }}>
          <div className="vp-cell">
            <span className="vp-label">world · SteamVR · full chain</span>
            <Scene3D w={vpW*0.5} h={vpH} defaultYaw={0.7} defaultPitch={0.3}>
              {(cam) => {
                const selT = mockPoses[selected % mockPoses.length];
                const Tt = makeT(0, 0.02, 0.01, 0.032, -0.011, 0.048);
                const Tg = makeT(0, -0.05, 0, 0.005, -0.062, 0.12);
                const Tcam = makeT(0, 0, 0, -0.01, 0.004, 0.038);
                const Ptracker = composeT(selT, Tt);
                const Pgripper = composeT(Ptracker, Tg);
                const Pcam = composeT(selT, Tcam);
                return (
                  <g>
                    {showTraj && <Traj3D points={mockPoses.map(T => applyT(T,[0,0,0]))} cam={cam} color="#b78cff" dotEvery={5}/>}
                    <Controller3D T={selT} cam={cam} label="ctrl"/>
                    <Tracker3D T={Ptracker} cam={cam}/>
                    <Gripper3D T={Pgripper} cam={cam}/>
                    <Frustum3D T={Pcam} cam={cam} fov={0.65} aspect={1.6} near={0.03} far={0.14} label="cam"/>
                    {showChain && (
                      <>
                        <RigidLink3D a={applyT(selT,[0,0,0])} b={applyT(Ptracker,[0,0,0])} cam={cam} color="#b78cff"/>
                        <RigidLink3D a={applyT(Ptracker,[0,0,0])} b={applyT(Pgripper,[0,0,0])} cam={cam} color="#ffa95a"/>
                        <RigidLink3D a={applyT(selT,[0,0,0])} b={applyT(Pcam,[0,0,0])} cam={cam} color="#8a97aa"/>
                      </>
                    )}
                  </g>
                );
              }}
            </Scene3D>
          </div>
          <div className="vp-cell">
            <span className="vp-label">gripper projected into camera</span>
            <CameraView w={vpW*0.5} h={vpH} seed={selected + 20} pp={[vpW*0.25, vpH*0.5]} showGrid={true}>
              <ChessboardOverlay cx={vpW*0.22} cy={vpH*0.7} cols={9} rows={6} tile={16}
                rotation={0.2} skew={0.1} tilt={0.4} showOrigin={true} showCorners={false}/>
            </CameraView>
            <div className="vp-corner-read">
              <div>{`T_${activePreset.from}_${activePreset.to}`}</div>
              <div>t <b>[ {tMm[0].toFixed(1)}, {tMm[1].toFixed(1)}, {tMm[2].toFixed(1)} ]</b></div>
              <div>mm  <b style={{color: transRms < 5 ? 'var(--ok)' : 'var(--warn)'}}>{transRms.toFixed(2)}</b></div>
              <div>deg <b style={{color: rotRms < 1 ? 'var(--ok)' : 'var(--warn)'}}>{rotRms.toFixed(3)}</b></div>
            </div>
          </div>
        </div>
      </div>

      <div className="rail">
        <div className="rail-header">
          <span>Results · {activePreset.label}</span>
          <span className="mono" style={{color: result?.ok ? 'var(--ok)' : 'var(--text-4)'}}>
            {result?.ok ? `● ${transRms.toFixed(1)} mm` : busy ? '● solving' : '○ idle'}
          </span>
        </div>
        <div className="rail-scroll">
          <Section title={`T_${activeLink}`}>
            <Matrix m={Tmat}/>
            <KV items={[
              ['t (mm)',  `[ ${tMm[0].toFixed(1)}, ${tMm[1].toFixed(1)}, ${tMm[2].toFixed(1)} ]`, ''],
              ['rpy (°)', `[ ${rpyDeg[0].toFixed(3)}, ${rpyDeg[1].toFixed(3)}, ${rpyDeg[2].toFixed(3)} ]`, ''],
              ['||t||',   `${tNorm.toFixed(2)} mm`, 'pos'],
            ]}/>
          </Section>
          <Section title="Link residuals" hint="per-frame deviation">
            <KV items={[
              ['rot rms',  `${rotRms.toFixed(3)}°`, rotRms < 1 ? 'pos' : 'warn'],
              ['trans rms',`${transRms.toFixed(2)} mm`, transRms < 5 ? 'pos' : 'warn'],
              ['N pairs',  `${result?.iterations ?? 0}`, ''],
            ]}/>
          </Section>
          <ErrorPanel rms={transRms} frames={frames.map(f=>f.err)} histData={histData}/>
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
