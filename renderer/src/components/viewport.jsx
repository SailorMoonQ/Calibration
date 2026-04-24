import React, { useMemo } from 'react';
import { mulberry32 } from '../lib/random.js';

function ScenePlate({ w = 800, h = 520, seed = 7 }) {
  const rnd = useMemo(() => mulberry32(seed), [seed]);
  const stars = useMemo(() => {
    const out = [];
    for (let i = 0; i < 140; i++) out.push([rnd() * w, rnd() * h, 0.3 + rnd() * 0.9]);
    return out;
  }, [w, h]);
  return (
    <g>
      <defs>
        <linearGradient id={`scene-bg-${seed}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#191e27"/>
          <stop offset="1" stopColor="#0e1218"/>
        </linearGradient>
        <radialGradient id={`scene-vig-${seed}`} cx="50%" cy="50%" r="65%">
          <stop offset="0" stopColor="#000" stopOpacity="0"/>
          <stop offset="1" stopColor="#000" stopOpacity="0.55"/>
        </radialGradient>
      </defs>
      <rect width={w} height={h} fill={`url(#scene-bg-${seed})`}/>
      <path d={`M 0 ${h*0.62} L ${w} ${h*0.58} L ${w} ${h} L 0 ${h} Z`} fill="#1a2029" opacity="0.6"/>
      {stars.map((s, i) => <circle key={i} cx={s[0]} cy={s[1]} r={s[2]*0.6} fill="#2a323e"/>)}
      <rect width={w} height={h} fill={`url(#scene-vig-${seed})`}/>
    </g>
  );
}

export function ChessboardOverlay({ cx, cy, cols = 9, rows = 6, tile = 28, rotation = 0, skew = 0.15, tilt = 0.5, showOrigin = true, showCorners = true, detected = true }) {
  const rnd = useMemo(() => mulberry32(Math.round(cx * 10 + cy)), [cx, cy]);

  const W = cols * tile, H = rows * tile;
  const p00 = [-W/2, -H/2], p10 = [W/2, -H/2], p01 = [-W/2, H/2], p11 = [W/2, H/2];
  const pts = [p00, p10, p11, p01].map(([x, y]) => {
    const c = Math.cos(rotation), s = Math.sin(rotation);
    let xr = x * c - y * s;
    let yr = x * s + y * c;
    xr = xr * (1 + tilt * (yr / H));
    yr = yr * (1 - skew * (xr / W));
    return [cx + xr, cy + yr * 0.75];
  });

  const corner = (u, v) => {
    const a = [pts[0][0] * (1-u) + pts[1][0] * u, pts[0][1] * (1-u) + pts[1][1] * u];
    const b = [pts[3][0] * (1-u) + pts[2][0] * u, pts[3][1] * (1-u) + pts[2][1] * u];
    return [a[0] * (1-v) + b[0] * v, a[1] * (1-v) + b[1] * v];
  };

  const tiles = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const tl = corner(i / cols, j / rows);
      const tr = corner((i+1) / cols, j / rows);
      const br = corner((i+1) / cols, (j+1) / rows);
      const bl = corner(i / cols, (j+1) / rows);
      const dark = (i + j) % 2 === 0;
      tiles.push(
        <path key={i + '-' + j}
              d={`M ${tl[0]} ${tl[1]} L ${tr[0]} ${tr[1]} L ${br[0]} ${br[1]} L ${bl[0]} ${bl[1]} Z`}
              fill={dark ? '#0f1319' : '#e8ecf1'}
              stroke="#22272f" strokeWidth="0.5"/>
      );
    }
  }

  const corners = [];
  for (let i = 1; i < cols; i++) {
    for (let j = 1; j < rows; j++) {
      const [x, y] = corner(i / cols, j / rows);
      const jitter = detected ? (rnd() - 0.5) * 0.6 : (rnd() - 0.5) * 4;
      corners.push({ x: x + jitter, y: y + jitter, i, j });
    }
  }

  const origin = corner(0, 0);
  const xend = corner(0.22, 0);
  const yend = corner(0, 0.22);
  const zend = [origin[0] + (origin[0] - (pts[0][0]+pts[1][0]+pts[2][0]+pts[3][0])/4) * 0.15, origin[1] - 36];

  return (
    <g>
      <g opacity="0.95">{tiles}</g>
      {showCorners && corners.map((c, i) => (
        <g key={i}>
          <circle cx={c.x} cy={c.y} r="3" fill="none" stroke="oklch(0.75 0.17 40)" strokeWidth="1"/>
          <circle cx={c.x} cy={c.y} r="0.8" fill="oklch(0.75 0.17 40)"/>
        </g>
      ))}
      {showOrigin && (
        <g>
          <line x1={origin[0]} y1={origin[1]} x2={xend[0]} y2={xend[1]} stroke="var(--axis-x)" strokeWidth="2.5"/>
          <line x1={origin[0]} y1={origin[1]} x2={yend[0]} y2={yend[1]} stroke="var(--axis-y)" strokeWidth="2.5"/>
          <line x1={origin[0]} y1={origin[1]} x2={zend[0]} y2={zend[1]} stroke="var(--axis-z)" strokeWidth="2.5"/>
          <circle cx={origin[0]} cy={origin[1]} r="3" fill="#fff" stroke="#000" strokeWidth="0.5"/>
          <text x={xend[0]+3} y={xend[1]+3} fontSize="10" fill="var(--axis-x)" fontFamily="JetBrains Mono">X</text>
          <text x={yend[0]+3} y={yend[1]+3} fontSize="10" fill="var(--axis-y)" fontFamily="JetBrains Mono">Y</text>
          <text x={zend[0]+3} y={zend[1]+3} fontSize="10" fill="var(--axis-z)" fontFamily="JetBrains Mono">Z</text>
        </g>
      )}
    </g>
  );
}

function Reticle({ w, h, showGrid = true, showPP = true, pp }) {
  const cx = pp ? pp[0] : w / 2;
  const cy = pp ? pp[1] : h / 2;
  return (
    <g pointerEvents="none">
      {showGrid && (
        <g stroke="rgba(255,255,255,0.07)" strokeWidth="1">
          {Array.from({length: 11}, (_, i) => (
            <line key={'v'+i} x1={w * i / 10} y1="0" x2={w * i / 10} y2={h}/>
          ))}
          {Array.from({length: 7}, (_, i) => (
            <line key={'h'+i} x1="0" y1={h * i / 6} x2={w} y2={h * i / 6}/>
          ))}
        </g>
      )}
      <rect x="20" y="20" width={w-40} height={h-40} fill="none" stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4"/>
      {showPP && (
        <g stroke="var(--accent-2)" strokeWidth="1">
          <line x1={cx - 10} y1={cy} x2={cx + 10} y2={cy}/>
          <line x1={cx} y1={cy - 10} x2={cx} y2={cy + 10}/>
          <circle cx={cx} cy={cy} r="3" fill="none"/>
          <text x={cx + 8} y={cy - 8} fontSize="9" fill="var(--accent-2)" fontFamily="JetBrains Mono">pp</text>
        </g>
      )}
    </g>
  );
}

export function ResidualVectors({ corners, scale = 8 }) {
  return (
    <g>
      {corners.map((c, i) => {
        const mag = Math.hypot(c.ex, c.ey);
        const color = mag > 0.6 ? 'var(--err)' : mag > 0.35 ? 'var(--warn)' : 'var(--ok)';
        return (
          <g key={i}>
            <line x1={c.x} y1={c.y} x2={c.x + c.ex * scale} y2={c.y + c.ey * scale} stroke={color} strokeWidth="1.25"/>
            <circle cx={c.x} cy={c.y} r="1.2" fill={color}/>
          </g>
        );
      })}
    </g>
  );
}

export function DistortionGrid({ w, h, k1 = -0.35, k2 = 0.15, color = 'rgba(120,190,255,0.45)', cols = 14, rows = 10 }) {
  const cx = w/2, cy = h/2;
  function warp(x, y) {
    const nx = (x - cx) / cx;
    const ny = (y - cy) / cy;
    const r2 = nx*nx + ny*ny;
    const f = 1 + k1 * r2 + k2 * r2 * r2;
    return [cx + nx * cx * f, cy + ny * cy * f];
  }
  const lines = [];
  for (let i = 0; i <= cols; i++) {
    const x = (i / cols) * w;
    const pts = [];
    for (let j = 0; j <= 40; j++) {
      const y = (j / 40) * h;
      pts.push(warp(x, y));
    }
    lines.push(<path key={'v'+i} d={pts.map((p, k) => (k?'L':'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')} stroke={color} fill="none" strokeWidth="0.8"/>);
  }
  for (let j = 0; j <= rows; j++) {
    const y = (j / rows) * h;
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const x = (i / 40) * w;
      pts.push(warp(x, y));
    }
    lines.push(<path key={'h'+j} d={pts.map((p, k) => (k?'L':'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')} stroke={color} fill="none" strokeWidth="0.8"/>);
  }
  return <g>{lines}</g>;
}

export function CameraView({ w, h, children, label, fisheye = false, rectified = false, showGrid = true, pp, seed }) {
  return (
    <svg className="fill" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        {fisheye && (
          <clipPath id={"fe-" + (seed || 0)}>
            <circle cx={w/2} cy={h/2} r={Math.min(w,h) * 0.48}/>
          </clipPath>
        )}
      </defs>
      <g clipPath={fisheye ? `url(#fe-${seed || 0})` : undefined}>
        <ScenePlate w={w} h={h} seed={seed || 3}/>
        {children}
      </g>
      {fisheye && (
        <circle cx={w/2} cy={h/2} r={Math.min(w,h) * 0.48} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
      )}
      <Reticle w={w} h={h} showGrid={showGrid} pp={pp} showPP={!fisheye || rectified}/>
      {label && <text x="10" y={h-10} fontSize="10" fill="rgba(255,255,255,0.4)" fontFamily="JetBrains Mono">{label}</text>}
    </svg>
  );
}

export function ErrorHeatmap({ w, h, seed = 5, peak = 0.45 }) {
  const rnd = useMemo(() => mulberry32(seed), [seed]);
  const cells = [];
  const cols = 18, rows = 12;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const nx = i / (cols-1) - 0.5, ny = j / (rows-1) - 0.5;
      const d = Math.hypot(nx, ny);
      const v = Math.max(0, 0.02 + d * 0.9 * peak + (rnd() - 0.5) * 0.1);
      const c = v > 0.5 ? 'oklch(0.6 0.18 25)' : v > 0.3 ? 'oklch(0.72 0.15 70)' : 'oklch(0.7 0.14 150)';
      cells.push(<rect key={i+'-'+j} x={i * w/cols} y={j * h/rows} width={w/cols+0.5} height={h/rows+0.5} fill={c} opacity={0.55}/>);
    }
  }
  return <g>{cells}</g>;
}
