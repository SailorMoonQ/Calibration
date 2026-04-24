import React, { useEffect, useState } from 'react';
import { api, mjpegUrl } from '../api/client.js';

export function LivePreview({ device, fps = 30, quality = 70 }) {
  const [url, setUrl] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!device) { setUrl(null); setInfo(null); return; }
    mjpegUrl(device, { fps, quality }).then(u => !cancelled && setUrl(u));
    // Poll capture stats once per second. The backend tracks grab FPS on its own thread,
    // so this reflects what's actually coming out of the camera — useful for diagnosing
    // driver buffering or dropped frames independent of client-side render rate.
    const id = setInterval(() => {
      api.streamInfo(device).then(i => !cancelled && setInfo(i)).catch(() => {});
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
      setUrl(null);
    };
  }, [device, fps, quality]);

  if (!device) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%', color: 'var(--view-text-2)',
        fontFamily: 'JetBrains Mono', fontSize: 11,
      }}>pick a camera to start the live preview</div>
    );
  }
  if (!url) return null;

  const capFps = info?.capture_fps;
  const fpsColor = capFps == null
    ? 'var(--view-text-2)'
    : capFps >= fps * 0.85 ? 'var(--ok)'
    : capFps >= fps * 0.5 ? 'var(--warn)'
    : 'var(--err)';

  return (
    <>
      <img src={url} alt={`live ${device}`}
           style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}/>
      <div className="vp-corner-read left">
        <div>capture <b style={{ color: fpsColor }}>{capFps != null ? capFps.toFixed(1) : '—'}</b> fps · target <b>{fps}</b></div>
        {info?.width != null && <div>{info.width}×{info.height}</div>}
        {info?.fps_advertised ? <div>drv {info.fps_advertised.toFixed(1)} fps</div> : null}
      </div>
    </>
  );
}
