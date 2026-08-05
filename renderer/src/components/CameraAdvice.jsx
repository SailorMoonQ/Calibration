import { useTranslation } from 'react-i18next';
import { assessCamera, focusHint, splitAdvice } from '../lib/cameraAdvice.js';

const DOT = { bad: 'var(--err)', warn: 'var(--warn)', ok: 'var(--ok)' };

// Live guidance for getting a camera into a state a calibration can use.
//
// The sliders and the histogram already say what the camera IS doing. This says
// what to change and why — and, where the fix is unambiguous, does it in one
// click. The alternative is expecting every operator to know that "clipped high
// 8%" means "shorten the exposure", which is exactly the knowledge the tool
// should be supplying.
export function CameraAdvice({ controls, stats, sharpnessPeak, onApply, busy }) {
  const { t } = useTranslation();
  const items = assessCamera({ controls, stats });
  const { problems, passing, worst } = splitAdvice(items);
  const focus = stats ? focusHint(stats.sharpness, sharpnessPeak) : null;

  if (!items.length && !focus) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
        {t('cameraParams.adviceWaiting')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: DOT[worst] }}/>
        <span style={{ color: 'var(--text-2)' }}>
          {problems.length === 0
            ? t('cameraParams.adviceAllGood')
            : t('cameraParams.adviceCount', { count: problems.length })}
        </span>
      </div>

      {problems.map(item => (
        <div key={item.id} style={{
          borderLeft: `2px solid ${DOT[item.level]}`, paddingLeft: 8,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ fontSize: 11.5, color: 'var(--text)', lineHeight: 1.45 }}>
            {t(`cameraParams.advice.${item.id}.title`)}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
            {t(`cameraParams.advice.${item.id}.why`)}
          </div>
          {item.action ? (
            <button className="btn" style={{ alignSelf: 'flex-start', fontSize: 10.5, padding: '2px 8px' }}
                    disabled={busy}
                    onClick={() => onApply(item.action)}>
              {t(`cameraParams.advice.${item.id}.fix`)}
            </button>
          ) : item.blockedBy ? (
            // No button, and the reason is worth stating: the control that would
            // fix this is locked, so the user needs to clear that first.
            <div style={{ fontSize: 10.5, color: 'var(--warn)' }}>
              {t('cameraParams.adviceBlocked', {
                parent: t(`cameraParams.ctrl.${item.blockedBy}`, { defaultValue: item.blockedBy }),
              })}
            </div>
          ) : null}
        </div>
      ))}

      {/* Focus is hunted by peak, not by absolute value: the number means nothing
          across scenes, but "62% of the best seen" tells you whether to keep
          turning the ring and roughly how far off you are. */}
      {focus && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
            <span style={{ color: 'var(--text-3)' }}>{t('cameraParams.focusPeak')}</span>
            <span className="mono" style={{ color: DOT[focus.level] }}>
              {(focus.ratio * 100).toFixed(0)}%
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--bg-2)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${focus.ratio * 100}%`, background: DOT[focus.level] }}/>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-4)', lineHeight: 1.4 }}>
            {t('cameraParams.focusPeakHint')}
          </div>
        </div>
      )}

      {passing.length > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--text-4)', lineHeight: 1.5 }}>
          {t('cameraParams.advicePassing', {
            list: passing.map(i => t(`cameraParams.advice.${i.id}.short`)).join('、'),
          })}
        </div>
      )}
    </div>
  );
}
