import React, { useEffect, useMemo, useRef, useState } from 'react';
import { streamWsUrl } from '../api/client.js';

// Binary frame layout from /stream/ws: [u32 LE json_len][json meta][jpeg bytes].
// Meta carries { seq, ts, image_size:[w,h], corners:[[x,y],...], ids }.
function parseFrame(buf) {
  const dv = new DataView(buf);
  const hLen = dv.getUint32(0, true);
  const head = new TextDecoder().decode(new Uint8Array(buf, 4, hLen));
  const meta = JSON.parse(head);
  const jpeg = new Uint8Array(buf, 4 + hLen);
  return { meta, jpeg };
}

export function LiveDetectedFrame({
  device, board,
  fps = 10, quality = 70, detect = true,
  showCorners = true, showOrigin = true,
}) {
  const [state, setState] = useState({ url: null, meta: null });
  const [err, setErr] = useState(null);
  const [capFps, setCapFps] = useState(null);
  const wsRef = useRef(null);
  const urlRef = useRef(null);
  const tickRef = useRef({ recent: [], last: 0 });

  // board key for effect deps
  const bType  = board?.type ?? 'chess';
  const bCols  = board?.cols ?? 9;
  const bRows  = board?.rows ?? 6;
  const bSq    = board?.sq ?? 0.025;
  const bMark  = board?.marker ?? null;

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    tickRef.current = { recent: [], last: 0 };

    (async () => {
      const url = await streamWsUrl(device, {
        fps, quality, detect,
        board: { type: bType, cols: bCols, rows: bRows, sq: bSq, marker: bMark },
      });
      if (cancelled) return;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        if (cancelled || !(ev.data instanceof ArrayBuffer)) return;
        let parsed;
        try { parsed = parseFrame(ev.data); }
        catch (e) { setErr(`decode: ${e.message}`); return; }
        const { meta, jpeg } = parsed;

        const blob = new Blob([jpeg], { type: 'image/jpeg' });
        const u = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = u;
        setState({ url: u, meta });

        // rolling client-side fps (arrival rate)
        const now = performance.now();
        const t = tickRef.current;
        t.recent.push(now);
        while (t.recent.length > 30) t.recent.shift();
        if (now - t.last > 500) {
          t.last = now;
          if (t.recent.length >= 2) {
            const dt = (t.recent[t.recent.length - 1] - t.recent[0]) / 1000;
            setCapFps(dt > 0 ? (t.recent.length - 1) / dt : null);
          }
        }
      };
      ws.onerror = () => !cancelled && setErr('ws error');
      ws.onclose = (ev) => {
        if (cancelled) return;
        if (ev.code !== 1000 && ev.code !== 1001) setErr(`ws closed (${ev.code})`);
      };
    })();

    return () => {
      cancelled = true;
      if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
      setState({ url: null, meta: null });
      setCapFps(null);
      setErr(null);
    };
  }, [device, fps, quality, detect, bType, bCols, bRows, bSq, bMark]);

  const meta = state.meta;
  const w = meta?.image_size?.[0] ?? 1920;
  const h = meta?.image_size?.[1] ?? 1200;
  const corners = meta?.corners ?? [];
  const cornerR = useMemo(() => Math.max(2, Math.round(Math.min(w, h) / 300)), [w, h]);
  const axisLen = useMemo(() => Math.min(w, h) * 0.06, [w, h]);

  const axes = useMemo(() => {
    if (!showOrigin || !corners.length || corners.length < bCols + 1) return null;
    const o = corners[0];
    const xref = corners[1];
    const yref = corners[bCols];
    const dx = [xref[0] - o[0], xref[1] - o[1]];
    const dy = [yref[0] - o[0], yref[1] - o[1]];
    const dn = (v) => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0]/L, v[1]/L]; };
    const [ex0, ex1] = dn(dx);
    const [ey0, ey1] = dn(dy);
    const zLen = axisLen * 0.85;
    return {
      o,
      xEnd: [o[0] + ex0 * axisLen, o[1] + ex1 * axisLen],
      yEnd: [o[0] + ey0 * axisLen, o[1] + ey1 * axisLen],
      zEnd: [o[0] - (ex1 + ey1) * zLen * 0.5, o[1] + (ex0 + ey0) * zLen * 0.5 - zLen],
    };
  }, [corners, bCols, axisLen, showOrigin]);

  const placeholderStyle = {
    display:'flex', alignItems:'center', justifyContent:'center',
    width:'100%', height:'100%', fontFamily:'JetBrains Mono', fontSize: 11,
  };
  if (!device) {
    return <div style={{ ...placeholderStyle, color:'var(--view-text-2)' }}>pick a camera to start the live preview</div>;
  }
  if (err) {
    return <div style={{ ...placeholderStyle, color:'var(--err)', padding: 16, textAlign:'center' }}>{err}</div>;
  }
  if (!state.url || !meta) {
    return <div style={{ ...placeholderStyle, color:'var(--view-text-2)' }}>connecting…</div>;
  }

  const detected = corners.length > 0;
  const fpsColor = capFps == null ? 'var(--view-text-2)'
    : capFps >= fps * 0.8 ? 'var(--ok)'
    : capFps >= fps * 0.4 ? 'var(--warn)'
    : 'var(--err)';

  return (
    <>
      <svg className="fill" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
        <image href={state.url} x={0} y={0} width={w} height={h} preserveAspectRatio="none"/>
        {showCorners && corners.map((c, i) => (
          <g key={i}>
            <circle cx={c[0]} cy={c[1]} r={cornerR * 2} fill="none"
                    stroke="oklch(0.75 0.17 40)" strokeWidth={cornerR * 0.4}/>
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
      </svg>
      <div className="vp-corner-read left">
        <div>live <b style={{ color: fpsColor }}>{capFps != null ? capFps.toFixed(1) : '—'}</b> fps · tgt <b>{fps}</b></div>
        <div>{w}×{h} · seq <b>{meta.seq}</b></div>
        {detect && (
          <div>detect <b style={{ color: detected ? 'var(--ok)' : 'var(--warn)' }}>{detected ? `${corners.length} corners` : '—'}</b></div>
        )}
      </div>
    </>
  );
}
