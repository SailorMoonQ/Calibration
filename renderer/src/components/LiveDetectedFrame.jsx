import React, { useEffect, useRef, useState } from 'react';
import { streamWsUrl } from '../api/client.js';
import { useReportCamera } from '../lib/telemetry.jsx';

// JPEG-per-message WebSocket → canvas via createImageBitmap. Same plumbing as
// LivePreview, plus we draw corner markers and the board origin axes on top of
// the frame imperatively (one canvas surface, no separate SVG overlay). Draws
// are coalesced through requestAnimationFrame so a 60 fps camera doesn't paint
// past the display refresh and stale bitmaps are dropped on the next frame.
//
// Wire format from /stream/ws:
//   [u32 LE json_len][json meta][jpeg bytes]
// meta: { seq, ts, image_size:[w,h], corners:[[x,y],...], ids }.
function parseFrame(buf) {
  const dv = new DataView(buf);
  const hLen = dv.getUint32(0, true);
  const head = new TextDecoder().decode(new Uint8Array(buf, 4, hLen));
  const meta = JSON.parse(head);
  const jpeg = new Uint8Array(buf, 4 + hLen);
  return { meta, jpeg };
}

const CORNER_COLOR = 'oklch(0.75 0.17 40)';

export function LiveDetectedFrame({
  device, board,
  fps = 10, quality = 70, detect = true,
  showCorners = true, showOrigin = true,
  onMeta,                 // optional: called each frame with the parsed meta
}) {
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [capFps, setCapFps] = useState(null);
  useReportCamera(device, capFps, fps);

  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const tickRef = useRef({ recent: [], last: 0 });
  // Keep onMeta in a ref so the websocket handler always sees the latest
  // closure without re-binding (which would tear down the stream every parent
  // render).
  const onMetaRef = useRef(onMeta);
  useEffect(() => { onMetaRef.current = onMeta; }, [onMeta]);

  // board key for effect deps
  const bType  = board?.type ?? 'chess';
  const bCols  = board?.cols ?? 9;
  const bRows  = board?.rows ?? 6;
  const bSq    = board?.sq ?? 0.025;
  const bMark  = board?.marker ?? null;

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let pending = null;          // { bitmap, meta } awaiting paint
    let rafId = null;
    tickRef.current = { recent: [], last: 0 };

    // Resolve theme colors once; canvas can't read CSS variables directly.
    // We re-read on each draw via getComputedStyle so the live preview tracks
    // theme changes without needing to remount.
    const readTheme = () => {
      const root = document.documentElement;
      const s = getComputedStyle(root);
      return {
        axisX: s.getPropertyValue('--axis-x').trim() || '#ef4a5a',
        axisY: s.getPropertyValue('--axis-y').trim() || '#4ec06a',
        axisZ: s.getPropertyValue('--axis-z').trim() || '#4a8cff',
      };
    };

    const draw = () => {
      rafId = null;
      const next = pending;
      pending = null;
      if (!next) return;
      const c = canvasRef.current;
      if (!c || cancelled) { next.bitmap.close(); return; }
      const w = next.bitmap.width;
      const h = next.bitmap.height;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const ctx = c.getContext('2d');
      ctx.drawImage(next.bitmap, 0, 0);
      next.bitmap.close();

      const corners = next.meta.corners ?? [];
      if (!corners.length) return;
      const cornerR = Math.max(2, Math.round(Math.min(w, h) / 300));

      if (showCorners) {
        ctx.strokeStyle = CORNER_COLOR;
        ctx.fillStyle = CORNER_COLOR;
        ctx.lineWidth = cornerR * 0.4;
        for (const [x, y] of corners) {
          ctx.beginPath();
          ctx.arc(x, y, cornerR * 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, cornerR * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (showOrigin && corners.length >= bCols + 1) {
        const o = corners[0];
        const xref = corners[1];
        const yref = corners[bCols];
        const norm = (vx, vy) => {
          const L = Math.hypot(vx, vy) || 1;
          return [vx / L, vy / L];
        };
        const [ex0, ex1] = norm(xref[0] - o[0], xref[1] - o[1]);
        const [ey0, ey1] = norm(yref[0] - o[0], yref[1] - o[1]);
        const axisLen = Math.min(w, h) * 0.06;
        const zLen = axisLen * 0.85;
        const xEnd = [o[0] + ex0 * axisLen, o[1] + ex1 * axisLen];
        const yEnd = [o[0] + ey0 * axisLen, o[1] + ey1 * axisLen];
        const zEnd = [
          o[0] - (ex1 + ey1) * zLen * 0.5,
          o[1] + (ex0 + ey0) * zLen * 0.5 - zLen,
        ];

        const theme = readTheme();
        ctx.lineWidth = cornerR * 0.9;
        ctx.lineCap = 'round';
        const stroke = (color, end) => {
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(o[0], o[1]);
          ctx.lineTo(end[0], end[1]);
          ctx.stroke();
        };
        stroke(theme.axisX, xEnd);
        stroke(theme.axisY, yEnd);
        stroke(theme.axisZ, zEnd);

        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = cornerR * 0.3;
        ctx.beginPath();
        ctx.arc(o[0], o[1], cornerR * 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };

    (async () => {
      const url = await streamWsUrl(device, {
        fps, quality, detect,
        board: { type: bType, cols: bCols, rows: bRows, sq: bSq, marker: bMark },
      });
      if (cancelled) return;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = async (ev) => {
        if (cancelled || !(ev.data instanceof ArrayBuffer)) return;
        let parsed;
        try { parsed = parseFrame(ev.data); }
        catch (e) { setErr(`decode: ${e.message}`); return; }

        const blob = new Blob([parsed.jpeg], { type: 'image/jpeg' });
        let bitmap;
        try { bitmap = await createImageBitmap(blob); }
        catch { return; }
        if (cancelled) { bitmap.close(); return; }

        if (pending) pending.bitmap.close();
        pending = { bitmap, meta: parsed.meta };
        if (rafId == null) rafId = requestAnimationFrame(draw);

        setMeta(parsed.meta);
        if (onMetaRef.current) {
          try { onMetaRef.current(parsed.meta); } catch (_) {}
        }

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
      if (rafId != null) cancelAnimationFrame(rafId);
      if (pending) { pending.bitmap.close(); pending = null; }
      if (wsRef.current) {
        try { wsRef.current.close(); } catch (_) {}
        wsRef.current = null;
      }
      setMeta(null);
      setCapFps(null);
      setErr(null);
    };
  }, [device, fps, quality, detect, bType, bCols, bRows, bSq, bMark, showCorners, showOrigin]);

  const placeholderStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '100%', height: '100%', fontFamily: 'JetBrains Mono', fontSize: 11,
  };
  if (!device) {
    return <div style={{ ...placeholderStyle, color: 'var(--view-text-2)' }}>pick a camera to start the live preview</div>;
  }
  if (err) {
    return <div style={{ ...placeholderStyle, color: 'var(--err)', padding: 16, textAlign: 'center' }}>{err}</div>;
  }

  const w = meta?.image_size?.[0];
  const h = meta?.image_size?.[1];
  const corners = meta?.corners ?? [];
  const detected = corners.length > 0;
  const fpsColor = capFps == null ? 'var(--view-text-2)'
    : capFps >= fps * 0.8 ? 'var(--ok)'
    : capFps >= fps * 0.4 ? 'var(--warn)'
    : 'var(--err)';

  return (
    <>
      <canvas ref={canvasRef}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}/>
      {!meta && (
        <div style={{
          position: 'absolute', inset: 0, ...placeholderStyle,
          color: 'var(--view-text-2)', pointerEvents: 'none',
        }}>connecting…</div>
      )}
      <div className="vp-corner-read left">
        <div>live <b style={{ color: fpsColor }}>{capFps != null ? capFps.toFixed(1) : '—'}</b> fps · tgt <b>{fps}</b></div>
        {w != null && h != null && <div>{w}×{h} · seq <b>{meta.seq}</b></div>}
        {detect && (
          <div>detect <b style={{ color: detected ? 'var(--ok)' : 'var(--warn)' }}>{detected ? `${corners.length} corners` : '—'}</b></div>
        )}
      </div>
    </>
  );
}
