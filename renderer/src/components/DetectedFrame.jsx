import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, frameUrl } from '../api/client.js';

// Cache detection results per (path|board-key) so switching frames is instant on revisit.
const detectionCache = new Map();

function boardKey(b) {
  return `${b.type}:${b.cols}x${b.rows}:${b.sq}:${b.marker ?? ''}`;
}

export function DetectedFrame({
  path, board,
  showCorners = true, showOrigin = true, overlay = 'none',
  residuals,                // optional [[x,y,ex,ey],...] — if present, used instead of live detection
  residualScale = 40,
}) {
  const [img, setImg] = useState(null);
  const [det, setDet] = useState(null);
  const [err, setErr] = useState(null);
  const reqSeq = useRef(0);

  // Load the image URL (async because backend info comes from Electron IPC)
  useEffect(() => {
    let cancelled = false;
    if (!path) return;
    frameUrl(path).then(u => !cancelled && setImg(u));
    return () => { cancelled = true; };
  }, [path]);

  // Detection — skipped when residuals are provided (calibration already detected).
  // We always reset state at the top of the effect so a previous frame's
  // {detected: false} doesn't bleed into the next frame and leave a stale
  // "no board detected" overlay on top of a perfectly-detected image.
  useEffect(() => {
    setErr(null);
    if (!path) { setDet(null); return; }
    if (residuals) { setDet(null); return; }  // calibrated frame — trust the residuals

    const key = `${path}|${boardKey(board)}`;
    const cached = detectionCache.get(key);
    if (cached) { setDet(cached); return; }

    const seq = ++reqSeq.current;
    setDet(null);
    api.detectFile({
      path,
      board: {
        type: board.type,
        cols: board.cols,
        rows: board.rows,
        square: board.sq,
        marker: board.marker ?? null,
        dictionary: 'DICT_5X5_100',
      },
    }).then(r => {
      if (seq !== reqSeq.current) return;
      detectionCache.set(key, r);
      setDet(r);
    }).catch(e => seq === reqSeq.current && setErr(e.message));
  }, [path, board.type, board.cols, board.rows, board.sq, board.marker, !!residuals]);

  const size = det?.image_size;
  const w = size?.[0] ?? 1920;
  const h = size?.[1] ?? 1200;

  const corners = residuals
    ? residuals.map(r => [r[0], r[1]])
    : (det?.corners ?? []);
  const cornerR = useMemo(() => Math.max(2, Math.round(Math.min(w, h) / 300)), [w, h]);
  const axisLen = useMemo(() => Math.min(w, h) * 0.06, [w, h]);

  // Origin axes: from corner 0, X toward corner 1 in row, Y toward second row.
  // We use the chessboard grid convention: cols inner corners per row.
  const axes = useMemo(() => {
    if (!showOrigin || corners.length < board.cols + 1) return null;
    const o = corners[0];
    const xref = corners[1];
    const yref = corners[board.cols];
    const dx = [xref[0] - o[0], xref[1] - o[1]];
    const dy = [yref[0] - o[0], yref[1] - o[1]];
    const dn = (v) => {
      const L = Math.hypot(v[0], v[1]) || 1;
      return [v[0] / L, v[1] / L];
    };
    const [ex0, ex1] = dn(dx);
    const [ey0, ey1] = dn(dy);
    // Z = right-handed normal, drawn as a short offset upward-into-camera
    const zLen = axisLen * 0.85;
    return {
      o, axisLen,
      xEnd: [o[0] + ex0 * axisLen, o[1] + ex1 * axisLen],
      yEnd: [o[0] + ey0 * axisLen, o[1] + ey1 * axisLen],
      zEnd: [o[0] - (ex1 + ey1) * zLen * 0.5, o[1] + (ex0 + ey0) * zLen * 0.5 - zLen],
    };
  }, [corners, board.cols, axisLen, showOrigin]);

  return (
    <svg className="fill" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      {img && <image href={img} x={0} y={0} width={w} height={h} preserveAspectRatio="none"/>}
      {overlay === 'heatmap' && det && (
        <rect x={0} y={0} width={w} height={h} fill="url(#none)" opacity={0}/>
      )}
      {overlay === 'residuals' && residuals && residuals.map((r, i) => {
        const mag = Math.hypot(r[2], r[3]);
        const color = mag > 0.6 ? 'var(--err)' : mag > 0.35 ? 'var(--warn)' : 'var(--ok)';
        return (
          <g key={'r' + i}>
            <line x1={r[0]} y1={r[1]} x2={r[0] + r[2] * residualScale} y2={r[1] + r[3] * residualScale}
                  stroke={color} strokeWidth={cornerR * 0.6}/>
            <circle cx={r[0]} cy={r[1]} r={cornerR * 0.6} fill={color}/>
          </g>
        );
      })}
      {showCorners && overlay !== 'residuals' && corners.map((c, i) => (
        <g key={i}>
          <circle cx={c[0]} cy={c[1]} r={cornerR * 2} fill="none" stroke="oklch(0.75 0.17 40)" strokeWidth={cornerR * 0.4}/>
          <circle cx={c[0]} cy={c[1]} r={cornerR * 0.5} fill="oklch(0.75 0.17 40)"/>
        </g>
      ))}
      {axes && (
        <g strokeWidth={cornerR * 0.9}>
          <line x1={axes.o[0]} y1={axes.o[1]} x2={axes.xEnd[0]} y2={axes.xEnd[1]} stroke="var(--axis-x)"/>
          <line x1={axes.o[0]} y1={axes.o[1]} x2={axes.yEnd[0]} y2={axes.yEnd[1]} stroke="var(--axis-y)"/>
          <line x1={axes.o[0]} y1={axes.o[1]} x2={axes.zEnd[0]} y2={axes.zEnd[1]} stroke="var(--axis-z)"/>
          <circle cx={axes.o[0]} cy={axes.o[1]} r={cornerR * 1.6} fill="#fff" stroke="#000" strokeWidth={cornerR * 0.3}/>
        </g>
      )}
      {det && !det.detected && (
        <g>
          <rect x={w * 0.5 - 120} y={h * 0.5 - 18} width={240} height={36} fill="rgba(0,0,0,0.6)" stroke="var(--err)"/>
          <text x={w * 0.5} y={h * 0.5 + 6} fontSize={Math.max(14, Math.round(h / 40))}
                fontFamily="JetBrains Mono" fill="var(--err)" textAnchor="middle">
            no board detected
          </text>
        </g>
      )}
      {err && (
        <g>
          <rect x={8} y={h - 32} width={320} height={24} fill="rgba(0,0,0,0.6)" stroke="var(--err)"/>
          <text x={14} y={h - 14} fontSize={Math.max(11, Math.round(h / 60))}
                fontFamily="JetBrains Mono" fill="var(--err)">detect error: {err}</text>
        </g>
      )}
    </svg>
  );
}
