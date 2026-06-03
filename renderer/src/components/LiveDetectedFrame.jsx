import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

// Detection-footprint heat is accumulated on a finer grid than the coverage
// cells so the "where can this lens actually be detected" region reads as a
// smooth blob rather than 8×5 blocks.
const FP_COLS = 40, FP_ROWS = 25;

export function LiveDetectedFrame({
  device, board,
  fps = 10, quality = 70, detect = true,
  showCorners = true, showOrigin = true,
  onMeta,                 // optional: called each frame with the parsed meta
  // Coverage overlay drawn directly on the frame (image-pixel coords, so it
  // stays aligned through object-fit letterboxing):
  coverageCells = null,   // bool[covCols*covRows] — which cells are already captured
  covCols = 8, covRows = 5,
  showCoverageGrid = false,
  showFootprint = false,  // accumulate + draw the detection-reachable heat
}) {
  const { t } = useTranslation();
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

  // Overlay config in a ref so the draw closure (set up once per stream) always
  // reads the freshest toggles/cells without re-binding the websocket.
  const covRef = useRef(null);
  useEffect(() => {
    covRef.current = { cells: coverageCells, cols: covCols, rows: covRows, showGrid: showCoverageGrid, showFootprint };
  }, [coverageCells, covCols, covRows, showCoverageGrid, showFootprint]);
  // Persistent detection-footprint accumulator (reset when the stream restarts).
  const footprintRef = useRef(new Float32Array(FP_COLS * FP_ROWS));

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
    footprintRef.current = new Float32Array(FP_COLS * FP_ROWS);

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
      const cornerR = Math.max(2, Math.round(Math.min(w, h) / 300));
      const cov = covRef.current;

      // ── Detection-footprint heat ──────────────────────────────────────────
      // Every detected corner bumps its fine-grid cell; the accumulated field is
      // painted as a green wash. Regions the lens can never resolve a corner in
      // (typically the fisheye periphery) stay dark — that's the answer to
      // "which areas can actually be scanned".
      if (cov?.showFootprint) {
        const fp = footprintRef.current;
        for (const [x, y] of corners) {
          const ci = Math.min(FP_COLS - 1, Math.max(0, Math.floor((x / w) * FP_COLS)));
          const ri = Math.min(FP_ROWS - 1, Math.max(0, Math.floor((y / h) * FP_ROWS)));
          const k = ri * FP_COLS + ci;
          fp[k] = Math.min(1, fp[k] + 0.2);
        }
        const cw = w / FP_COLS, ch = h / FP_ROWS;
        for (let k = 0; k < fp.length; k++) {
          const v = fp[k];
          if (v <= 0.02) continue;
          const ci = k % FP_COLS, ri = (k / FP_COLS) | 0;
          ctx.fillStyle = `oklch(0.72 0.15 165 / ${(0.05 + v * 0.3).toFixed(3)})`;
          ctx.fillRect(ci * cw, ri * ch, cw + 0.5, ch + 0.5);
        }
      }

      // ── Coverage grid ─────────────────────────────────────────────────────
      // Captured cells fill green, empty cells outline red, and the cell the
      // board currently sits in pulses amber — so the user can steer the target
      // into the gaps without ever looking away from the live frame.
      if (cov?.showGrid && cov.cells) {
        const cols = cov.cols, rows = cov.rows;
        const gw = w / cols, gh = h / rows;
        let curCell = -1;
        if (corners.length) {
          let sx = 0, sy = 0;
          for (const [x, y] of corners) { sx += x; sy += y; }
          const cx = sx / corners.length, cy = sy / corners.length;
          const ci = Math.min(cols - 1, Math.max(0, Math.floor((cx / w) * cols)));
          const ri = Math.min(rows - 1, Math.max(0, Math.floor((cy / h) * rows)));
          curCell = ri * cols + ci;
        }
        ctx.lineWidth = Math.max(1, cornerR * 0.25);
        for (let k = 0; k < cols * rows; k++) {
          const ci = k % cols, ri = (k / cols) | 0;
          const x0 = ci * gw, y0 = ri * gh;
          const on = cov.cells[k];
          if (on) {
            ctx.fillStyle = 'oklch(0.72 0.16 150 / 0.16)';
            ctx.fillRect(x0, y0, gw, gh);
          }
          ctx.strokeStyle = on ? 'oklch(0.78 0.15 150 / 0.55)' : 'oklch(0.7 0.13 30 / 0.4)';
          ctx.strokeRect(x0 + 0.5, y0 + 0.5, gw - 1, gh - 1);
        }
        if (curCell >= 0) {
          const ci = curCell % cols, ri = (curCell / cols) | 0;
          ctx.strokeStyle = 'oklch(0.85 0.18 90 / 0.95)';
          ctx.lineWidth = Math.max(2, cornerR * 0.55);
          ctx.strokeRect(ci * gw + 1.5, ri * gh + 1.5, gw - 3, gh - 3);
        }
      }

      if (!corners.length) return;

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
          try { onMetaRef.current(parsed.meta); } catch { /* swallow */ }
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
        try { wsRef.current.close(); } catch { /* swallow */ }
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
    return <div style={{ ...placeholderStyle, color: 'var(--view-text-2)' }}>{t('preview.pickCamera')}</div>;
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
        }}>{t('preview.connecting')}</div>
      )}
      <div className="vp-corner-read left">
        <div>{t('preview.live')} <b style={{ color: fpsColor }}>{capFps != null ? capFps.toFixed(1) : '—'}</b> fps · {t('preview.tgt')} <b>{fps}</b></div>
        {w != null && h != null && <div>{w}×{h} · seq <b>{meta.seq}</b></div>}
        {detect && (
          <div>{t('preview.detect')} <b style={{ color: detected ? 'var(--ok)' : 'var(--warn)' }}>{detected ? t('preview.cornersN', { count: corners.length }) : '—'}</b></div>
        )}
      </div>
    </>
  );
}
