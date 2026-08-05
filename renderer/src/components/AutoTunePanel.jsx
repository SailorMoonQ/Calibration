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
// The one decision the operator must make is whether the board will be moving:
// a handheld board smears past ~16 ms, while a board on a stand can take as long
// as it likes. That single choice changes what is achievable more than anything
// else, which is why it is a visible control rather than a hidden constant.
export function AutoTunePanel({ device, onDone, disabled }) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [handheld, setHandheld] = useState(true);
  const [showTrace, setShowTrace] = useState(false);

  const run = async () => {
    if (!device) return;
    setRunning(true); setError(''); setResult(null);
    try {
      const r = await api.autotuneCamera({
        device,
        exposure_max_ms: handheld ? 16 : 200,
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

  const dot = result ? (result.ok ? 'var(--ok)' : 'var(--warn)') : 'var(--text-4)';

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
              {result.ok ? t('cameraParams.tuneOk') : t('cameraParams.tunePartial')}
            </span>
          </div>

          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
            {t('cameraParams.tuneExposure')} <b style={{ color: 'var(--text)' }}>{result.exposure_ms} ms</b>
            {' · '}{t('cameraParams.tuneGain')} <b style={{ color: 'var(--text)' }}>{result.state?.gain}</b>
            <br/>
            {t('cameraParams.tuneWhite')} <b style={{ color: 'var(--text)' }}>{result.final?.p95}</b>
            {' / '}{result.targets?.p95}
            {' · '}{result.iterations} {t('cameraParams.tuneSteps')}
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
