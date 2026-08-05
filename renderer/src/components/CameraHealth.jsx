import { useTranslation } from 'react-i18next';
import { evaluateHealth, readControlMetrics } from '../lib/cameraHealth.js';

// "Is this camera set up correctly?" — answered with named thresholds instead of
// an impression.
//
// The readouts next door each answer a fragment: the histogram shows the shape,
// the clip percentages show the ends, the toolbar shows the frame rate. Deciding
// whether that adds up to a usable camera was left to the operator, which is
// exactly the knowledge the tool should be supplying. This is the same set of
// thresholds the closed-loop tuner drives to, so a freshly tuned camera reads
// green here by construction.
//
// It runs live off the preview sample, not only after a tuning run: touching any
// slider changes the answer, and an answer that only appears after a tune would
// go stale the moment anyone experimented.

function dotColor(check) {
  if (check.ok) return 'var(--ok)';
  return check.severity === 'blocking' ? 'var(--err)' : 'var(--warn)';
}

function formatValue(check) {
  switch (check.id) {
    case 'clipHigh':
    case 'clipLow':
      return `${(check.value * 100).toFixed(1)}% / ≤${(check.want * 100).toFixed(0)}%`;
    case 'gain':
      return `${Math.round(check.value * 100)}% / ≤${Math.round(check.want * 100)}%`;
    case 'exposureBudget':
      return `${check.value.toFixed(1)} / ≤${check.want.toFixed(1)} ms`;
    case 'frameRate':
      return `${check.value.toFixed(1)} / ${check.want} fps`;
    default:
      return `${check.value} / ${check.want}`;
  }
}

export function CameraHealth({ controls, stats, fps, fpsTarget }) {
  const { t } = useTranslation();

  const fromControls = readControlMetrics(controls);
  const health = evaluateHealth({
    p95: stats?.p95 ?? null,
    clipHigh: stats?.high ?? null,
    clipLow: stats?.low ?? null,
    fps: fps ?? null,
    fpsTarget: fpsTarget ?? 0,
    ...fromControls,
  });

  if (!health.known) {
    return (
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
        {t('cameraParams.health.waiting')}
      </div>
    );
  }

  const verdictColor = health.verdict === 'ok' ? 'var(--ok)' : 'var(--warn)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%',
                       background: health.ok ? 'var(--ok)' : 'var(--warn)' }}/>
        <span style={{ color: 'var(--text-2)' }}>
          {health.ok ? t('cameraParams.health.pass') : t('cameraParams.health.fail')}
        </span>
        {health.verdict !== 'ok' && health.verdict !== 'unknown' && (
          <span className="mono" style={{ fontSize: 10.5, color: verdictColor }}>
            {t(`cameraParams.health.verdict.${health.verdict}`)}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {health.checks.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto',
                           background: dotColor(c), transform: 'translateY(-1px)' }}/>
            <span style={{ color: 'var(--text-2)', flex: '1 1 auto' }}>
              {t(`cameraParams.health.check.${c.id}`)}
            </span>
            <span className="mono" style={{ fontSize: 10, color: c.ok ? 'var(--text-3)' : dotColor(c) }}>
              {formatValue(c)}
            </span>
          </div>
        ))}
      </div>

      {/* One line naming the cause, only when there is one. A failing check with
          no explanation just relocates the puzzle. */}
      {health.checks.filter(c => !c.ok && c.detail).map(c => {
        const text = c.id === 'exposureBudget'
          ? t('cameraParams.health.why.exposureBudget', { fps: c.detail })
          : t(`cameraParams.health.why.${c.id}.${c.detail}`, { defaultValue: '' });
        if (!text) return null;
        return (
          <div key={`${c.id}-why`} style={{ fontSize: 10.5, color: 'var(--warn)', lineHeight: 1.5 }}>
            {text}
          </div>
        );
      })}
    </div>
  );
}
