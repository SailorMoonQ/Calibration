import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from './primitives.jsx';
import { api } from '../api/client.js';

// One-click exposure/gain tuning.
//
// The guidance list next door tells you what to change; this just does it. It is
// closed loop — measure, adjust, measure — because V4L2 leaves the meaning of a
// gain unit undefined, so no formula can predict what a given write will do. The
// camera's own response is the only reliable source of truth.
//
// Two decisions bound what the loop can reach, and both are the operator's:
//
//   * whether the board will be moving — a handheld board smears past ~16 ms;
//   * what frame rate must survive — a sensor cannot integrate for longer than
//     one frame period, so asking for 60 fps IS asking for exposure ≤ 16.7 ms.
//     Measured on the rig: 33 ms → 30 fps, 200 ms → 5 fps, exactly
//     1000/exposure_ms. Without this the loop would happily walk a dim room's
//     exposure out to 200 ms and quietly leave the camera at 5 fps.
//
// The tighter of the two caps wins, and the panel says which one is binding —
// "steady the board" and "accept fewer frames" are opposite actions.
export function AutoTunePanel({ device, onDone, disabled, fpsTarget, onFpsTarget }) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [handheld, setHandheld] = useState(true);
  const [showTrace, setShowTrace] = useState(false);

  const blurCap = handheld ? 16 : 200;
  const fpsCap = fpsTarget > 0 ? 1000 / fpsTarget : Infinity;
  const cap = Math.min(blurCap, fpsCap);
  const capReason = fpsCap < blurCap ? 'fps' : 'blur';

  const run = async () => {
    if (!device) return;
    setRunning(true); setError(''); setResult(null);
    try {
      const r = await api.autotuneCamera({
        device,
        exposure_max_ms: blurCap,
        fps_target: fpsTarget,
        // Handheld: a slightly soft but well-exposed frame still has corners; a
        // dark one does not. Fixed rig: there is no blur to trade against, so
        // the cap is generous and never binds.
        allow_exceed_blur: true,
      });
      setResult(r);
      onDone?.(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  // "On target" means every stated goal was met, frame rate included. Reporting
  // it while an issue is still listed next to it is a contradiction the operator
  // cannot act on — and the health checklist alongside would disagree.
  const fullyOk = !!result?.ok && !(result.issues || []).length;
  const dot = result ? (fullyOk ? 'var(--ok)' : 'var(--warn)') : 'var(--text-4)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Field label={t('cameraParams.mounting')}>
        <div className="seg full">
          <button className={handheld ? 'on' : ''} onClick={() => setHandheld(true)}>
            {t('cameraParams.handheld')}
          </button>
          <button className={!handheld ? 'on' : ''} onClick={() => setHandheld(false)}>
            {t('cameraParams.fixed')}
          </button>
        </div>
      </Field>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
        {handheld ? t('cameraParams.handheldNote') : t('cameraParams.fixedNote')}
      </div>

      <Field label={t('cameraParams.fpsTarget')}>
        <div className="seg full">
          {[60, 30, 0].map(v => (
            <button key={v} className={fpsTarget === v ? 'on' : ''}
                    onClick={() => onFpsTarget?.(v)}>
              {v === 0 ? t('cameraParams.fpsAny') : `${v}`}
            </button>
          ))}
        </div>
      </Field>
      {/* Which limit is actually binding, in numbers. Two caps whose interaction
          is invisible is how the 200 ms / 5 fps result happened in the first
          place. */}
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
        {t('cameraParams.capNote', {
          ms: cap.toFixed(1),
          reason: t(`cameraParams.capReason.${capReason}`),
        })}
      </div>

      <button className="btn primary" style={{ width: '100%' }}
              disabled={disabled || running || !device} onClick={run}>
        {running ? t('cameraParams.tuning') : t('cameraParams.autoTune')}
      </button>

      {error && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--err)', lineHeight: 1.5 }}>
          {t('cameraParams.tuneFailed', { error })}
        </div>
      )}

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }}/>
            <span style={{ color: 'var(--text-2)' }}>
              {fullyOk ? t('cameraParams.tuneOk') : t('cameraParams.tunePartial')}
            </span>
          </div>

          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
            {t('cameraParams.tuneExposure')} <b style={{ color: 'var(--text)' }}>{result.exposure_ms} ms</b>
            {' · '}{t('cameraParams.tuneGain')} <b style={{ color: 'var(--text)' }}>{result.state?.gain}</b>
            <br/>
            {t('cameraParams.tuneWhite')} <b style={{ color: 'var(--text)' }}>{result.final?.p95}</b>
            {' / '}{result.targets?.p95}
            {' · '}{result.iterations} {t('cameraParams.tuneSteps')}
            {/* Measured, not derived: a short exposure that still runs slow means
                the ceiling is the sensor mode or the USB link at this
                resolution, and no tuning will lift it. */}
            {result.fps != null && (
              <>
                <br/>
                {t('cameraParams.tuneFps')} <b style={{ color: 'var(--text)' }}>{result.fps}</b> fps
                {result.targets?.fps_target > 0 && ` / ${result.targets.fps_target}`}
              </>
            )}
          </div>

          {/* Anything the loop could not achieve is stated, not buried. A run
              that ends dark because the room is dark is a useful answer — the
              fix is a lamp, and no amount of retrying will substitute. */}
          {result.issues?.length > 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--warn)', lineHeight: 1.5 }}>
              {result.issues.map(i => t(`cameraParams.tuneIssue.${i}`, { defaultValue: i })).join('　')}
            </div>
          )}

          <button className="btn ghost" style={{ fontSize: 10, alignSelf: 'flex-start', padding: '1px 6px' }}
                  onClick={() => setShowTrace(v => !v)}>
            {showTrace ? t('cameraParams.hideTrace') : t('cameraParams.showTrace')}
          </button>
          {showTrace && (
            <div className="mono" style={{ fontSize: 9.5, color: 'var(--text-4)', lineHeight: 1.5 }}>
              {(result.trace || []).map(r => (
                <div key={r.i}>
                  exp {String(r.exposure).padStart(5)} · gain {String(r.gain).padStart(3)} · p95 {String(r.p95).padStart(5)} → {r.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
