import { useTranslation } from 'react-i18next';
import { Field, Seg } from './primitives.jsx';

export const TWEAKS_DEFAULTS = {
  theme: 'dark',
  density: 'comfortable',
  accentHue: 295,
};

export function TweaksPanel({ visible, tweaks, setTweaks, onClose }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div className="tweaks-panel">
      <div className="tweaks-head">
        <span>{t('tweaks.title')}</span>
        <button className="btn ghost sm" onClick={onClose}>×</button>
      </div>
      <div className="tweaks-body">
        <Field label={t('tweaks.theme')}>
          <Seg value={tweaks.theme} onChange={v => setTweaks({...tweaks, theme: v})} full options={[{value:'light',label:t('tweaks.light')},{value:'dark',label:t('tweaks.dark')}]}/>
        </Field>
        <Field label={t('tweaks.density')}>
          <Seg value={tweaks.density} onChange={v => setTweaks({...tweaks, density: v})} full options={[{value:'compact',label:t('tweaks.compact')},{value:'comfortable',label:t('tweaks.comfy')}]}/>
        </Field>
        <Field label={t('tweaks.accentHue')}>
          <div className="slider-row">
            <input type="range" min="0" max="360" value={tweaks.accentHue} onChange={e => setTweaks({...tweaks, accentHue: +e.target.value})}/>
            <span className="mono">{tweaks.accentHue}°</span>
          </div>
        </Field>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button className="btn sm block" onClick={() => setTweaks({ ...TWEAKS_DEFAULTS })}>{t('tweaks.reset')}</button>
        </div>
      </div>
    </div>
  );
}
