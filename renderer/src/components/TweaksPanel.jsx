import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field, Seg, Chk } from './primitives.jsx';
import { api, voiceQrUrl } from '../api/client.js';

export const TWEAKS_DEFAULTS = {
  theme: 'dark',
  density: 'comfortable',
  accentHue: 295,
  voiceCommands: false,   // phone microphone over LAN
  voicePrompts: false,    // spoken cues (Edge-TTS clips, zh)
};

export function TweaksPanel({ visible, tweaks, setTweaks, onClose }) {
  const { t } = useTranslation();
  const [voiceInfo, setVoiceInfo] = useState(null);
  const [qrSrc, setQrSrc] = useState('');
  const [qrError, setQrError] = useState('');

  useEffect(() => {
    if (!visible || !tweaks.voiceCommands) return undefined;
    let cancelled = false;
    Promise.all([api.voiceInfo(), voiceQrUrl()])
      .then(([info, qr]) => {
        if (cancelled) return;
        setVoiceInfo(info);
        setQrSrc(qr);
        setQrError('');
      })
      .catch((e) => {
        if (!cancelled) setVoiceInfo({ ok: false, error: e.message });
      });
    return () => { cancelled = true; };
  }, [visible, tweaks.voiceCommands]);

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
        {tweaks.voiceCommands && (
          <div className="voice-pair">
            {voiceInfo?.ok ? (
              <>
                <div className="voice-qr">
                  {qrSrc && !qrError ? (
                    <img
                      src={qrSrc}
                      alt={t('tweaks.voiceQrAlt')}
                      onError={() => setQrError(t('tweaks.voiceQrLoadFailed'))}
                    />
                  ) : (
                    <span>{qrError || t('tweaks.voiceStarting')}</span>
                  )}
                </div>
                <div className="voice-url mono">{voiceInfo.url}</div>
                <div className={`voice-hint${qrError ? ' err' : ''}`}>{qrError || t('tweaks.voiceHttpsHint')}</div>
              </>
            ) : (
              <div className="voice-hint err">
                {voiceInfo ? t('tweaks.voiceStartFailed', { error: voiceInfo.error || 'unknown' }) : t('tweaks.voiceStarting')}
              </div>
            )}
          </div>
        )}
        <Chk checked={tweaks.voicePrompts} onChange={v => setTweaks({ ...tweaks, voicePrompts: v })}>
          {t('tweaks.voicePrompts')}
        </Chk>

        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button className="btn sm block" onClick={() => setTweaks({ ...TWEAKS_DEFAULTS })}>{t('tweaks.reset')}</button>
        </div>
      </div>
    </div>
  );
}
