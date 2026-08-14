import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Section, Field } from '../components/primitives.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { useCameraSource, CameraSourcePanel } from '../components/CameraSource.jsx';
import { ControlWidget } from '../components/ControlWidget.jsx';
import { ExposureStats } from '../components/ExposureStats.jsx';
import { CameraAdvice } from '../components/CameraAdvice.jsx';
import { AutoTunePanel } from '../components/AutoTunePanel.jsx';
import { CameraHealth } from '../components/CameraHealth.jsx';
import { confirm } from '../components/confirm.jsx';
import { api } from '../api/client.js';

// Camera parameters (exposure / gain / white balance / focus).
//
// Image quality is upstream of every calibration in this app: an overexposed
// board loses its white squares, an underexposed one loses its black ones, and a
// soft one defeats sub-pixel corner refinement. Until now the only way to touch
// those was v4l2-ctl on the command line.
//
// Controls are enumerated from the driver rather than hard-coded, so an
// unfamiliar camera still gets a working panel. Sources that cannot carry V4L2
// controls (ROS2 topics, owned by their driver node) say so instead of showing
// an inert panel.
export function CameraParamsTab() {
  const { t } = useTranslation();
  const cam = useCameraSource({ pollEnabled: true });
  const { liveDevice, streamInfo } = cam;

  const [data, setData] = useState(null);      // full /camera/controls payload
  const [busy, setBusy] = useState(false);
  const [status, setStatusMsg] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const setStatus = (msg, isErr = false) => { setStatusMsg(msg); setStatusErr(isErr); };
  const [presetName, setPresetName] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [stats, setStats] = useState(null);
  // What frame rate must survive the tuning. Owned here rather than inside the
  // tuner panel because the health checklist judges against the same number —
  // two independent copies would let the panel call a run "on target" while the
  // checklist next to it reported the frame rate missed.
  const [fpsTarget, setFpsTarget] = useState(60);
  // Best sharpness seen for this camera. Focus is hunted by peak — the absolute
  // Laplacian variance means nothing across scenes, so the useful readout is
  // "how close are you to the best you have found". Reset when the device
  // changes, since a peak from another camera is not a target for this one.
  const [sharpPeak, setSharpPeak] = useState(0);
  useEffect(() => { setSharpPeak(0); setStats(null); }, [liveDevice]);
  const onStats = useCallback((s) => {
    setStats(s);
    setSharpPeak(p => (s.sharpness > p ? s.sharpness : p));
  }, []);

  // LivePreview hands us its canvas ref. Store the ref OBJECT, never its current
  // value: the canvas is replaced whenever the device changes, and a snapshot
  // taken at mount time would go stale silently — the readout would simply stop
  // updating with no error anywhere.
  const canvasHolder = useRef(null);
  const onCanvas = useCallback((ref) => { canvasHolder.current = ref ?? null; }, []);
  const canvasRef = useMemo(() => ({ get current() { return canvasHolder.current?.current ?? null; } }), []);

  const refresh = useCallback(async (device) => {
    if (!device) { setData(null); return; }
    try {
      const r = await api.cameraControls(device);
      setData(r);
      if (!r.supported) setStatus(t(`cameraParams.reason.${r.reason}`, { defaultValue: r.reason }), true);
      else setStatus('');
    } catch (e) {
      setData(null);
      setStatus(t('cameraParams.loadFailed', { error: e.message }), true);
    }
  }, [t]);

  useEffect(() => { refresh(liveDevice); }, [liveDevice, refresh]);

  const onSet = useCallback(async (name, value) => {
    if (!liveDevice) return;
    setBusy(true);
    try {
      const r = await api.setCameraControl(liveDevice, name, value);
      setData(r);
      const res = r.set || {};
      if (res.ok === false) {
        // The driver rejected it. Say so rather than leaving a slider sitting at
        // a value the camera never accepted.
        if (res.error === 'control-is-inactive') {
          setStatus(t('cameraParams.setInactive', { name }), true);
        } else {
          setStatus(t('cameraParams.setRejected', { name, error: res.error }), true);
        }
      } else if (res.adjusted) {
        // The value was outside the driver's range or off its step grid. The
        // driver would have clamped it silently; saying so is the difference
        // between "it worked" and "it worked, but not with your number".
        setStatus(t('cameraParams.setAdjusted', { name, value: res.value }));
      } else {
        setStatus('');
      }
    } catch (e) {
      setStatus(t('cameraParams.setFailed', { name, error: e.message }), true);
    } finally {
      setBusy(false);
    }
  }, [liveDevice, t]);

  const onUnlock = useCallback((parentId, unlockValue) => onSet(parentId, unlockValue), [onSet]);

  // An advice action can be a pair — lowering gain without raising exposure just
  // makes the picture dark, which costs the black squares and is worse than the
  // noise it was meant to fix. Applied in the order the advice gives them.
  const applyAdvice = useCallback(async (action) => {
    const sets = action.sets || [{ control: action.control, value: action.value }];
    for (const s of sets) {
      // Sequential, not parallel: each write returns the refreshed control list,
      // and a later write must see the state the earlier one produced (raising
      // exposure can change what the driver will accept for gain).
      // eslint-disable-next-line no-await-in-loop
      await onSet(s.control, s.value);
    }
  }, [onSet]);

  const mutate = useCallback(async (body) => {
    if (!liveDevice) return;
    setBusy(true);
    try {
      await api.mutateCameraPresets({ device: liveDevice, ...body });
      await refresh(liveDevice);
      setStatus('');
    } catch (e) {
      setStatus(t('cameraParams.presetFailed', { error: e.message }), true);
    } finally {
      setBusy(false);
    }
  }, [liveDevice, refresh, t]);

  const controls = data?.controls ?? [];
  const common = controls.filter(c => c.common);
  const rest = controls.filter(c => !c.common);
  const presets = data?.presets?.presets ?? {};
  const activePreset = data?.presets?.active ?? null;
  const supported = !!data?.supported;

  const currentValues = useMemo(() => {
    const o = {};
    for (const c of controls) if (c.value != null) o[c.id] = c.value;
    return o;
  }, [controls]);

  const onSavePreset = async () => {
    const name = presetName.trim();
    if (!name) { setStatus(t('cameraParams.needPresetName'), true); return; }
    await mutate({ action: 'save', name, values: currentValues });
    setPresetName('');
  };

  const onDeletePreset = async (name) => {
    const ok = await confirm({
      message: t('cameraParams.confirmDeletePreset', { name }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (ok) await mutate({ action: 'delete', name });
  };

  const onReset = async () => {
    const ok = await confirm({
      message: t('cameraParams.confirmReset'),
      confirmLabel: t('cameraParams.reset'),
      cancelLabel: t('common.cancel'),
    });
    if (ok) await mutate({ action: 'reset' });
  };

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>{t('cameraParams.railTitle')}</span>
          <span className="mono" style={{ color: supported ? 'var(--ok)' : 'var(--text-4)' }}>
            {supported ? t('cameraParams.nControls', { count: controls.length }) : t('common.idle')}
          </span>
        </div>
        <div className="rail-scroll">
          <CameraSourcePanel source={cam}/>

          {!supported && data && (
            <Section title={t('cameraParams.unsupported')}>
              <div className="mono" style={{ fontSize: 11, color: 'var(--warn)', lineHeight: 1.5 }}>
                {t(`cameraParams.reason.${data.reason}`, { defaultValue: data.reason })}
              </div>
            </Section>
          )}

          {supported && (
            <Section title={t('cameraParams.presets')} hint={activePreset || t('cameraParams.noPreset')}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                {Object.keys(presets).length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('cameraParams.noPresetsYet')}</div>
                )}
                {Object.keys(presets).map(name => (
                  <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button className={`btn${name === activePreset ? ' primary' : ''}`}
                            style={{ flex: 1, fontSize: 11, textAlign: 'left' }}
                            disabled={busy}
                            onClick={() => mutate({ action: 'activate', name })}>
                      {name}
                    </button>
                    <button className="btn danger" style={{ padding: '2px 6px', fontSize: 10 }}
                            disabled={busy} onClick={() => onDeletePreset(name)}>×</button>
                  </div>
                ))}
              </div>
              <Field label={t('cameraParams.saveAs')}>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input className="input" style={{ flex: 1 }} value={presetName}
                         placeholder={t('cameraParams.presetNamePlaceholder')}
                         onChange={e => setPresetName(e.target.value)}
                         onKeyDown={e => { if (e.key === 'Enter') onSavePreset(); }}/>
                  <button className="btn" disabled={busy} onClick={onSavePreset}>{t('common.save')}</button>
                </div>
              </Field>
              <button className="btn ghost" style={{ width: '100%', marginTop: 6 }}
                      disabled={busy} onClick={onReset}>
                {t('cameraParams.reset')}
              </button>
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
                {t('cameraParams.persistNote')}
              </div>
            </Section>
          )}

          {status && (
            <Section title={t('cameraParams.status')}>
              <div className="mono" style={{ fontSize: 10.5, color: statusErr ? 'var(--err)' : 'var(--text-3)', lineHeight: 1.5 }}>
                {status}
              </div>
            </Section>
          )}
        </div>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <div className="spacer"/>
          <div className="read">
            {streamInfo?.open && (
              <>{streamInfo.width}×{streamInfo.height} · <b>{streamInfo.capture_fps?.toFixed(1) ?? '—'}</b> fps</>
            )}
          </div>
        </div>
        <div className="vp-body vp-split" style={{ gridTemplateColumns: '1fr' }}>
          <div className="vp-cell">
            <span className="vp-label">
              {liveDevice ? t('cameraParams.liveLabel', { device: liveDevice }) : t('cameraParams.noCamera')}
            </span>
            {liveDevice
              ? <LivePreview device={liveDevice} onCanvas={onCanvas}/>
              : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: 'var(--view-text-2)', fontFamily: 'JetBrains Mono', fontSize: 11 }}>
                  {t('cameraParams.pickCamera')}
                </div>}
          </div>
        </div>
      </div>

      <div className="rail">
        <div className="rail-header"><span>{t('cameraParams.exposureReadout')}</span></div>
        <div className="rail-scroll">
          <Section title={t('cameraParams.exposureReadout')}>
            <ExposureStats canvasRef={canvasRef} active={!!liveDevice} onStats={onStats}/>
          </Section>

          {supported && (
            <>
              <Section title={t('cameraParams.autoTuneTitle')}>
                <AutoTunePanel device={liveDevice} disabled={busy}
                               fpsTarget={fpsTarget} onFpsTarget={setFpsTarget}
                               controls={controls} stats={stats} onApply={applyAdvice}
                               onDone={() => refresh(liveDevice)}/>
              </Section>

              <Section title={t('cameraParams.health.title')}>
                <CameraHealth controls={controls} stats={stats}
                              fps={streamInfo?.capture_fps} fpsTarget={fpsTarget}/>
              </Section>

              <Section title={t('cameraParams.adviceTitle')}>
                <CameraAdvice controls={controls} stats={stats} sharpnessPeak={sharpPeak}
                              onApply={applyAdvice} busy={busy}/>
              </Section>

              <Section title={t('cameraParams.commonControls')}>
                {common.map(c => (
                  <ControlWidget key={c.id} control={c} onSet={onSet} onUnlock={onUnlock} busy={busy}/>
                ))}
                {common.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('cameraParams.noCommon')}</div>
                )}
              </Section>

              <Section title={t('cameraParams.allControls')} hint={String(rest.length)}>
                <button className="btn ghost" style={{ width: '100%', marginBottom: 6 }}
                        onClick={() => setShowAll(v => !v)}>
                  {showAll ? t('cameraParams.collapse') : t('cameraParams.expand')}
                </button>
                {showAll && rest.map(c => (
                  <ControlWidget key={c.id} control={c} onSet={onSet} onUnlock={onUnlock} busy={busy}/>
                ))}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
