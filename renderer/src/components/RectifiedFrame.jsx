import React, { useEffect, useState } from 'react';
import { fetchRectifiedBlob } from '../api/client.js';

export function RectifiedFrame({ path, K, D, balance = 0.5, fovScale = 1.0 }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);

  // Stable deps for the effect: K and D are arrays and change identity each render,
  // so key off their content.
  const kKey = K ? JSON.stringify(K) : '';
  const dKey = D ? JSON.stringify(D) : '';

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;
    if (!path || !K || !D) { setUrl(null); return; }
    setErr(null);
    fetchRectifiedBlob({ path, K, D, balance, fov_scale: fovScale })
      .then(blob => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(e => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, kKey, dKey, balance, fovScale]);

  if (err) {
    return (
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', height:'100%', color:'var(--err)',
        fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign: 'center',
      }}>{err}</div>
    );
  }
  if (!path || !K || !D) {
    return (
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', height:'100%', color:'var(--view-text-2)',
        fontFamily:'JetBrains Mono', fontSize: 11,
      }}>calibrate to see the rectified view</div>
    );
  }
  if (!url) {
    return (
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', height:'100%', color:'var(--view-text-2)',
        fontFamily:'JetBrains Mono', fontSize: 11,
      }}>rectifying…</div>
    );
  }
  return <img src={url} alt="rectified"
              style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }}/>;
}
