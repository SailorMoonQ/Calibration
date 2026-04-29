import React, { useEffect, useRef, useState } from 'react';
import { api, streamWsUrl } from '../api/client.js';
import { useReportCamera } from '../lib/telemetry.jsx';

// JPEG-per-message WebSocket → canvas via createImageBitmap. The previous
// MJPEG-via-<img> path leaked Chromium connection slots on tab switch (the
// multipart parser doesn't reliably abort on src clear), so we fetch frames
// over a WebSocket and decode them off the main thread. Draws are coalesced
// through requestAnimationFrame so a 60 fps camera doesn't paint past the
// display refresh, and any in-flight bitmap is dropped on the next frame.
//
// Wire format, matched by /stream/ws and LiveDetectedFrame:
//   [u32 LE json_len][json meta][jpeg bytes]
// LivePreview ignores meta — we only need the JPEG bytes.
function parseFrame(buf) {
  const dv = new DataView(buf);
  const hLen = dv.getUint32(0, true);
  const jpeg = new Uint8Array(buf, 4 + hLen);
  return jpeg;
}

export function LivePreview({ device, fps = 30, quality = 70 }) {
  const [info, setInfo] = useState(null);
  const [hasFrame, setHasFrame] = useState(false);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!device) { setInfo(null); setHasFrame(false); return; }
    let cancelled = false;
    let pending = null;        // ImageBitmap waiting to be drawn
    let rafId = null;

    const draw = () => {
      rafId = null;
      const bm = pending;
      pending = null;
      if (!bm) return;
      const c = canvasRef.current;
      if (!c || cancelled) { bm.close(); return; }
      if (c.width !== bm.width || c.height !== bm.height) {
        c.width = bm.width;
        c.height = bm.height;
      }
      const ctx = c.getContext('2d');
      ctx.drawImage(bm, 0, 0);
      bm.close();
    };

    (async () => {
      const wsUrl = await streamWsUrl(device, { fps, quality, detect: false });
      if (cancelled) return;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onmessage = async (ev) => {
        if (cancelled || !(ev.data instanceof ArrayBuffer)) return;
        let jpeg;
        try { jpeg = parseFrame(ev.data); } catch { return; }
        const blob = new Blob([jpeg], { type: 'image/jpeg' });
        let bm;
        try { bm = await createImageBitmap(blob); }
        catch { return; }
        if (cancelled) { bm.close(); return; }
        // Latest-wins: drop any bitmap that hasn't drawn yet so we never paint
        // older frames after newer ones have arrived.
        if (pending) pending.close();
        pending = bm;
        if (!hasFrame) setHasFrame(true);
        if (rafId == null) rafId = requestAnimationFrame(draw);
      };
    })();

    // Slow poll: capture_fps / advertised fps / resolution don't change often,
    // and each /stream/info call goes through source_manager.get + release with
    // a wait_frame inside, so over-polling adds real per-call cost. 2 s feels
    // live enough for the corner readout without thrashing the source.
    const id = setInterval(() => {
      api.streamInfo(device).then(i => !cancelled && setInfo(i)).catch(() => {});
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(id);
      if (rafId != null) cancelAnimationFrame(rafId);
      if (pending) { pending.close(); pending = null; }
      if (wsRef.current) {
        try { wsRef.current.close(); } catch (_) {}
        wsRef.current = null;
      }
      setHasFrame(false);
      setInfo(null);
    };
    // hasFrame intentionally excluded — flipping it shouldn't tear down the
    // socket and re-open at the new size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, fps, quality]);
  useReportCamera(device, info?.capture_fps, fps);

  if (!device) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%', color: 'var(--view-text-2)',
        fontFamily: 'JetBrains Mono', fontSize: 11,
      }}>pick a camera to start the live preview</div>
    );
  }

  const capFps = info?.capture_fps;
  const fpsColor = capFps == null
    ? 'var(--view-text-2)'
    : capFps >= fps * 0.85 ? 'var(--ok)'
    : capFps >= fps * 0.5 ? 'var(--warn)'
    : 'var(--err)';

  return (
    <>
      <canvas ref={canvasRef}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}/>
      {!hasFrame && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--view-text-2)', fontFamily: 'JetBrains Mono', fontSize: 11,
          pointerEvents: 'none',
        }}>connecting…</div>
      )}
      <div className="vp-corner-read left">
        <div>capture <b style={{ color: fpsColor }}>{capFps != null ? capFps.toFixed(1) : '—'}</b> fps · target <b>{fps}</b></div>
        {info?.width != null && <div>{info.width}×{info.height}</div>}
        {info?.fps_advertised ? <div>drv {info.fps_advertised.toFixed(1)} fps</div> : null}
      </div>
    </>
  );
}
