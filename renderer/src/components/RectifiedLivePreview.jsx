import React, { useEffect, useState } from 'react';
import { rectifiedMjpegUrl } from '../api/client.js';

// Live MJPEG stream undistorted on the backend. <img> handles the multipart frames;
// when K/D/model/(balance|fovScale|alpha)/method change we generate a new URL
// (with cache-bust) so the stream reopens with fresh maps.
export function RectifiedLivePreview({
  device, K, D,
  model = 'fisheye',
  balance = 0.5, fovScale = 1.0,
  alpha = 0.5,
  method = 'remap', fps = 15, quality = 75,
}) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);

  // Stable deps — K/D arrays change identity each render even when values are the same.
  const kKey = K ? JSON.stringify(K) : '';
  const dKey = D ? JSON.stringify(D) : '';

  useEffect(() => {
    if (!device || !K || !D || !D.length) { setUrl(null); return; }
    let cancelled = false;
    setErr(null);
    rectifiedMjpegUrl(device, {
      K, D, model,
      balance, fov_scale: fovScale,
      alpha,
      method, fps, quality,
    })
      .then(u => { if (!cancelled) setUrl(u); })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [device, kKey, dKey, model, balance, fovScale, alpha, method, fps, quality]);

  const placeholder = (text, color = 'var(--view-text-2)') => (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      width:'100%', height:'100%', color,
      fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign: 'center',
    }}>{text}</div>
  );

  if (err) return placeholder(err, 'var(--err)');
  if (!device) return placeholder('pick a camera to rectify');
  if (!K || !D || !D.length) return placeholder('run calibration to see the rectified view');
  if (!url) return placeholder('starting…');
  return <img src={url} alt={`rectified ${device}`}
              style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }}/>;
}
