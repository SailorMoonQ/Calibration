import React from 'react';
import { Pill } from './primitives.jsx';
import { useTelemetry } from '../lib/telemetry.jsx';

// Map a /dev/videoN path to a short label. Anything else falls through.
function camLabel(device) {
  const m = /^\/dev\/video(\d+)$/.exec(device);
  return m ? `cam${m[1]}` : device;
}

function fpsStatus(fps, target) {
  if (fps == null || !Number.isFinite(fps) || fps <= 0) return 'bad';
  if (target && fps >= target * 0.85) return 'ok';
  if (target && fps >= target * 0.5)  return 'warn';
  return 'bad';
}

function basesStatus(bases) {
  if (bases >= 2) return 'ok';
  if (bases === 1) return 'warn';
  return 'bad';
}

function dropStatus(pct) {
  if (pct < 1) return 'ok';
  if (pct <= 5) return 'warn';
  return 'bad';
}

export function Topbar({ mode, onMode }) {
  const { cameras, poses } = useTelemetry();

  const camPills = Object.entries(cameras)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([device, { fps, target }]) => (
      <Pill key={`cam:${device}`} status={fpsStatus(fps, target)}>
        {camLabel(device)} {fps != null ? fps.toFixed(1) : '—'} fps
      </Pill>
    ));

  const showSteamVR = poses && Array.isArray(poses.source) && poses.source.includes('steamvr');
  const steamPill = showSteamVR ? (
    <Pill key="steamvr" status={basesStatus(poses.bases ?? 0)}>
      SteamVR · {poses.bases ?? 0} bases
    </Pill>
  ) : null;

  const dropPills = poses && poses.perDevice
    ? Object.entries(poses.perDevice)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { dropPct }]) => (
          <Pill key={`drop:${name}`} status={dropStatus(dropPct)}>
            {name} drop {dropPct.toFixed(1)}%
          </Pill>
        ))
    : [];

  return (
    <div className="topbar">
      <span className="brand"><span className="brand-mark"/>Calibration Workbench</span>
      <span className="divider"/>
      <div className="session">
        {camPills}
        {steamPill}
        {dropPills}
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
