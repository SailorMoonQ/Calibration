import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { TelemetryProvider } from './lib/telemetry.jsx';
import { Topbar } from './components/Topbar.jsx';
import { Tabs } from './components/Tabs.jsx';
import { TWEAKS_DEFAULTS } from './components/TweaksPanel.jsx';
import { LogStrip } from './components/panels.jsx';
import { ConfirmHost } from './components/confirm.jsx';
import { IntrinsicsTab } from './tabs/IntrinsicsTab.jsx';
import { FisheyeTab } from './tabs/FisheyeTab.jsx';
import { HandEyeTab } from './tabs/HandEyeTab.jsx';
import { LinkCalibTab } from './tabs/LinkCalibTab.jsx';
import { api, voiceEventsUrl } from './api/client.js';
import { dispatchVoiceCommand } from './lib/voiceControl.js';

// label/sub are resolved per-render via i18n (see buildTabs); id/num/badge/Comp
// are language-independent.
const TAB_DEFS = [
  { id: 'intrinsics', num: '01', badge: 'ok',   Comp: IntrinsicsTab },
  { id: 'fisheye',    num: '02', badge: 'warn', Comp: FisheyeTab },
  { id: 'handeye',    num: '03', badge: 'ok',   Comp: HandEyeTab },
  { id: 'link',       num: '04', badge: 'ok',   Comp: LinkCalibTab },
];

export function App() {
  const { t } = useTranslation();
  const [active, setActive] = useState(() => localStorage.getItem('calib_tab') || 'intrinsics');
  const [tweaks, setTweaks] = useState(() => {
    // Merge stored prefs over defaults so new keys (e.g. voice) appear for
    // existing users, and a corrupt blob falls back cleanly.
    try {
      const saved = JSON.parse(localStorage.getItem('calib_tweaks') || '{}');
      return { ...TWEAKS_DEFAULTS, ...saved };
    } catch { return { ...TWEAKS_DEFAULTS }; }
  });
  const [tweaksVisible, setTweaksVisible] = useState(false);
  // Eye-in-hand vs eye-to-hand is a property of the physical rig, not a per-tab
  // setting — Hand-Eye owns the toggle, Link reads it for its own solver.
  const [solvePattern, setSolvePattern] = useState(
    () => localStorage.getItem('calib_handeye_pattern') || 'eye_in_hand',
  );

  useEffect(() => { localStorage.setItem('calib_tab', active); }, [active]);
  useEffect(() => { localStorage.setItem('calib_handeye_pattern', solvePattern); }, [solvePattern]);
  useEffect(() => { localStorage.setItem('calib_tweaks', JSON.stringify(tweaks)); }, [tweaks]);

  useEffect(() => {
    if (!tweaks.voiceCommands) {
      api.voiceStop?.().catch(() => {});
      return undefined;
    }
    let es = null;
    let cancelled = false;
    api.voiceInfo().catch((e) => console.warn('voice mobile entry failed', e));
    voiceEventsUrl().then((url) => {
      if (cancelled) return;
      es = new EventSource(url);
      es.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.kind === 'command' && msg.command) {
          dispatchVoiceCommand(msg);
        }
      };
    }).catch((e) => {
      console.warn('voice command stream failed', e);
    });
    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, [tweaks.voiceCommands]);

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

  const tabDef = TAB_DEFS.find(d => d.id === active) || TAB_DEFS[0];
  const ActiveComp = tabDef.Comp;
  const tabs = TAB_DEFS.map(d => ({
    ...d,
    label: t(`tabs.${d.id}.label`),
    sub: t(`tabs.${d.id}.sub`),
  }));

  return (
    <TelemetryProvider>
      <div className="app">
        <Topbar
          tweaks={tweaks} setTweaks={setTweaks}
          settingsOpen={tweaksVisible}
          onToggleSettings={() => setTweaksVisible(v => !v)}
          onCloseSettings={() => setTweaksVisible(false)}/>
        <Tabs tabs={tabs} value={active} onChange={setActive}/>
        <ActiveComp active={active} solvePattern={solvePattern} setSolvePattern={setSolvePattern} tweaks={tweaks}/>
        <LogStrip lines={[]}/>
        <ConfirmHost/>
      </div>
    </TelemetryProvider>
  );
}
