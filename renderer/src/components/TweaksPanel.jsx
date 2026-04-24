import React from 'react';
import { Field, Seg } from './primitives.jsx';

export const TWEAKS_DEFAULTS = {
  theme: 'light',
  density: 'comfortable',
  accentHue: 250,
};

export function TweaksPanel({ visible, tweaks, setTweaks, onClose }) {
  if (!visible) return null;
  return (
    <div className="tweaks-panel">
      <div className="tweaks-head">
        <span>Tweaks</span>
        <button className="btn ghost sm" onClick={onClose}>×</button>
      </div>
      <div className="tweaks-body">
        <Field label="theme">
          <Seg value={tweaks.theme} onChange={v => setTweaks({...tweaks, theme: v})} full options={[{value:'light',label:'light'},{value:'dark',label:'dark'}]}/>
        </Field>
        <Field label="density">
          <Seg value={tweaks.density} onChange={v => setTweaks({...tweaks, density: v})} full options={[{value:'compact',label:'compact'},{value:'comfortable',label:'comfy'}]}/>
        </Field>
        <Field label="accent hue">
          <div className="slider-row">
            <input type="range" min="0" max="360" value={tweaks.accentHue} onChange={e => setTweaks({...tweaks, accentHue: +e.target.value})}/>
            <span className="mono">{tweaks.accentHue}°</span>
          </div>
        </Field>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button className="btn sm block" onClick={() => setTweaks({ ...TWEAKS_DEFAULTS })}>reset</button>
        </div>
      </div>
    </div>
  );
}
