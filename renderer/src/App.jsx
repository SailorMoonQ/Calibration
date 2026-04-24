import React, { useState, useEffect } from 'react';
import { Topbar } from './components/Topbar.jsx';
import { Tabs } from './components/Tabs.jsx';
import { TweaksPanel, TWEAKS_DEFAULTS } from './components/TweaksPanel.jsx';
import { LogStrip } from './components/panels.jsx';
import { IntrinsicsTab } from './tabs/IntrinsicsTab.jsx';
import { FisheyeTab } from './tabs/FisheyeTab.jsx';
import { ExtrinsicsTab } from './tabs/ExtrinsicsTab.jsx';
import { HandEyeHMDTab } from './tabs/HandEyeHMDTab.jsx';
import { HandEyeCtrlTab } from './tabs/HandEyeCtrlTab.jsx';
import { ChainTab } from './tabs/ChainTab.jsx';

const TAB_DEFS = [
  { id: 'intrinsics', num: '01', label: 'Pinhole',    sub: 'intrinsics',      badge: 'ok',   Comp: IntrinsicsTab },
  { id: 'fisheye',    num: '02', label: 'Fish-eye',   sub: 'intrinsics',      badge: 'warn', Comp: FisheyeTab },
  { id: 'extrinsics', num: '03', label: 'Extrinsics', sub: 'cam ↔ cam',       badge: 'ok',   Comp: ExtrinsicsTab },
  { id: 'he_hmd',     num: '04', label: 'Hand-Eye',   sub: 'cam ↔ HMD',       badge: 'ok',   Comp: HandEyeHMDTab },
  { id: 'he_ctrl',    num: '05', label: 'Hand-Eye',   sub: 'cam ↔ ctrl',      badge: 'ok',   Comp: HandEyeCtrlTab },
  { id: 'chain',      num: '06', label: 'Chain',      sub: 'ctrl → gripper',  badge: 'ok',   Comp: ChainTab },
];

export function App() {
  const [active, setActive] = useState(() => localStorage.getItem('calib_tab') || 'intrinsics');
  const [mode, setMode] = useState('live');
  const [tweaks, setTweaks] = useState({ ...TWEAKS_DEFAULTS });
  const [tweaksVisible, setTweaksVisible] = useState(false);

  useEffect(() => { localStorage.setItem('calib_tab', active); }, [active]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', tweaks.theme);
    root.style.setProperty('--accent',      `oklch(0.62 0.14 ${tweaks.accentHue})`);
    root.style.setProperty('--accent-2',    `oklch(0.72 0.11 ${tweaks.accentHue})`);
    root.style.setProperty('--accent-soft', `oklch(0.95 0.03 ${tweaks.accentHue})`);
    root.style.setProperty('--accent-line', `oklch(0.55 0.16 ${tweaks.accentHue})`);
    root.style.setProperty('--ui', tweaks.density === 'compact' ? '12px' : '13px');
  }, [tweaks]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setTweaksVisible(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tabDef = TAB_DEFS.find(t => t.id === active) || TAB_DEFS[0];
  const ActiveComp = tabDef.Comp;

  return (
    <div className="app">
      <Topbar mode={mode} onMode={setMode}/>
      <Tabs tabs={TAB_DEFS} value={active} onChange={setActive}/>
      <ActiveComp/>
      <LogStrip lines={[
        active === 'intrinsics' ? 'solver: LM converged in 24 iters · Δcost 7.2e-7' : 'joint bundle adjustment · 132 constraints active',
        active === 'fisheye' ? 'fisheye/equidistant · k₁…k₄ estimated · ω 195.3°' : 'T_ctrl_cam saved to session_0419.toml [calib.hand_eye]'
      ]}/>
      <TweaksPanel visible={tweaksVisible} tweaks={tweaks} setTweaks={setTweaks} onClose={() => setTweaksVisible(false)}/>
    </div>
  );
}
