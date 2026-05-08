import { useState, useEffect } from 'react';
import { TelemetryProvider } from './lib/telemetry.jsx';
import { Topbar } from './components/Topbar.jsx';
import { Tabs } from './components/Tabs.jsx';
import { TweaksPanel, TWEAKS_DEFAULTS } from './components/TweaksPanel.jsx';
import { LogStrip } from './components/panels.jsx';
import { IntrinsicsTab } from './tabs/IntrinsicsTab.jsx';
import { FisheyeTab } from './tabs/FisheyeTab.jsx';
import { HandEyeTab } from './tabs/HandEyeTab.jsx';
import { LinkCalibTab } from './tabs/LinkCalibTab.jsx';

const TAB_DEFS = [
  { id: 'intrinsics', num: '01', label: 'Pinhole',    sub: 'intrinsics',         badge: 'ok',   Comp: IntrinsicsTab },
  { id: 'fisheye',    num: '02', label: 'Fish-eye',   sub: 'intrinsics',         badge: 'warn', Comp: FisheyeTab },
  { id: 'handeye',    num: '03', label: 'Hand-Eye',   sub: 'cam ↔ tracker',      badge: 'ok',   Comp: HandEyeTab },
  { id: 'link',       num: '04', label: 'Link',       sub: 'tracker ↔ ctrl',     badge: 'ok',   Comp: LinkCalibTab },
];

export function App() {
  const [active, setActive] = useState(() => localStorage.getItem('calib_tab') || 'intrinsics');
  const [tweaks, setTweaks] = useState({ ...TWEAKS_DEFAULTS });
  const [tweaksVisible, setTweaksVisible] = useState(false);
  // Eye-in-hand vs eye-to-hand is a property of the physical rig, not a per-tab
  // setting — Hand-Eye owns the toggle, Link reads it for its own solver.
  const [solvePattern, setSolvePattern] = useState(
    () => localStorage.getItem('calib_handeye_pattern') || 'eye_in_hand',
  );

  useEffect(() => { localStorage.setItem('calib_tab', active); }, [active]);
  useEffect(() => { localStorage.setItem('calib_handeye_pattern', solvePattern); }, [solvePattern]);

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
    <TelemetryProvider>
      <div className="app">
        <Topbar/>
        <Tabs tabs={TAB_DEFS} value={active} onChange={setActive}/>
        <ActiveComp solvePattern={solvePattern} setSolvePattern={setSolvePattern}/>
        <LogStrip lines={[
          active === 'intrinsics' ? 'solver: LM converged in 24 iters · Δcost 7.2e-7' : 'joint bundle adjustment · 132 constraints active',
          active === 'fisheye' ? 'fisheye/equidistant · k₁…k₄ estimated · ω 195.3°' : 'T_ctrl_cam saved to session_0419.toml [calib.hand_eye]'
        ]}/>
        <TweaksPanel visible={tweaksVisible} tweaks={tweaks} setTweaks={setTweaks} onClose={() => setTweaksVisible(false)}/>
      </div>
    </TelemetryProvider>
  );
}
