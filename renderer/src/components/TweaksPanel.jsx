import { useTranslation } from 'react-i18next';
import { Field, Seg, Chk } from './primitives.jsx';
import { voiceSupported } from '../lib/voice.js';

export const TWEAKS_DEFAULTS = {
  theme: 'dark',
  density: 'comfortable',
  accentHue: 295,
  voiceCommands: false,   // hands-free voice control (browser SpeechRecognition)
  voicePrompts: false,    // spoken cues (Edge-TTS clips)
  voiceLang: 'zh-CN',     // recognition + prompt language
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

        <div className="tweaks-section-label" style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 8, marginBottom: 2 }}>
          {t('tweaks.voice')}
        </div>
        <Chk checked={tweaks.voiceCommands} onChange={v => setTweaks({ ...tweaks, voiceCommands: v })}>
          {t('tweaks.voiceCommands')}
        </Chk>
        <Chk checked={tweaks.voicePrompts} onChange={v => setTweaks({ ...tweaks, voicePrompts: v })}>
          {t('tweaks.voicePrompts')}
        </Chk>
        <Field label={t('tweaks.voiceLang')}>
          <Seg value={tweaks.voiceLang} onChange={v => setTweaks({ ...tweaks, voiceLang: v })} full options={[
            { value: 'zh-CN', label: '中文' }, { value: 'en-US', label: 'English' },
          ]}/>
        </Field>
        {tweaks.voiceCommands && !voiceSupported() && (
          <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 2 }}>{t('tweaks.voiceUnsupported')}</div>
        )}

        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button className="btn sm block" onClick={() => setTweaks({ ...TWEAKS_DEFAULTS })}>{t('tweaks.reset')}</button>
        </div>
      </div>
    </div>
  );
}
