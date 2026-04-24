import React from 'react';
import { Pill } from './primitives.jsx';

export function Topbar({ mode, onMode }) {
  return (
    <div className="topbar">
      <span className="brand"><span className="brand-mark"/>Calibration Workbench</span>
      <span className="divider"/>
      <div className="session">
        <Pill status="ok">cam0 30.1 fps</Pill>
        <Pill status="ok">SteamVR · 2 bases</Pill>
        <Pill status="warn">tracker·3 drop 0.2%</Pill>
      </div>
      <span className="divider"/>
      <span className="session"><span className="path">~/projects/vr_rig/calib/session_0419.toml</span></span>
      <span className="spacer"/>
      <div className="mode-toggle">
        <button className={mode === 'live' ? 'on' : ''} onClick={() => onMode('live')}>live</button>
        <button className={mode === 'bag' ? 'on' : ''} onClick={() => onMode('bag')}>bag</button>
      </div>
      <button className="btn">↓ import yaml</button>
      <button className="btn">↑ export bundle</button>
      <button className="btn ghost icon" title="settings">⚙</button>
    </div>
  );
}
