import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { frameStats } from '../lib/imageStats.js';

// How often to sample the preview canvas. getImageData is a GPU→CPU readback and
// is the expensive part, not the arithmetic — so we throttle by frame count
// rather than by resolution.
const SAMPLE_EVERY_MS = 200;
const TREND_SECONDS = 5;
const TREND_POINTS = Math.round((TREND_SECONDS * 1000) / SAMPLE_EVERY_MS);

// Thresholds for calling exposure "bad". Deliberately loose: a calibration board
// has large white squares, so a few percent of clipping is normal and only a
// sustained double-digit reading means detail is actually being lost.
const CLIP_WARN = 0.02;
const CLIP_BAD = 0.10;

function clipColor(v) {
  if (v >= CLIP_BAD) return 'var(--err)';
  if (v >= CLIP_WARN) return 'var(--warn)';
  return 'var(--ok)';
}

// Live exposure/focus readout computed from whatever canvas the preview is
// drawing into. Nothing is asked of the backend — the pixels are already on
// screen, so reading them costs one readback per sample rather than a second
// stream or a detection pass.
export function ExposureStats({ canvasRef, active = true }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState(null);
  const trendRef = useRef([]);
  const [trend, setTrend] = useState([]);

  useEffect(() => {
    if (!active) { setStats(null); trendRef.current = []; setTrend([]); return undefined; }
    let timer = null;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const c = canvasRef?.current;
      if (c && c.width > 0 && c.height > 0) {
        try {
          const ctx = c.getContext('2d', { willReadFrequently: true });
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const s = frameStats(img.data, c.width, c.height);
          if (s) {
            setStats(s);
            const arr = trendRef.current;
            arr.push(s.sharpness);
            if (arr.length > TREND_POINTS) arr.shift();
            setTrend([...arr]);
          }
        } catch {
          // A tainted or not-yet-painted canvas is expected during startup and
          // on stream switches — skip this sample rather than tearing the loop
          // down, because the next frame usually works.
        }
      }
      timer = setTimeout(tick, SAMPLE_EVERY_MS);
    };
    timer = setTimeout(tick, SAMPLE_EVERY_MS);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [canvasRef, active]);

  if (!stats) {
    return (
      <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', padding: '6px 0' }}>
        {t('cameraParams.waitingForFrames')}
      </div>
    );
  }

  const { hist, high, low, mean, sharpness } = stats;
  let peak = 1;
  for (let i = 0; i < 256; i++) if (hist[i] > peak) peak = hist[i];
  const trendMax = Math.max(1, ...trend);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Brightness histogram. Log-ish scaling (sqrt) so a single dominant bucket
          — very common on a mostly-white calibration board — does not flatten
          everything else into invisibility. */}
      <svg width="100%" height="52" preserveAspectRatio="none" viewBox="0 0 256 52"
           style={{ background: 'var(--surface-2)', border: '1px solid var(--border-soft)' }}>
        {Array.from({ length: 256 }).map((_, i) => {
          const hgt = Math.sqrt(hist[i] / peak) * 50;
          const edge = i <= 2 || i >= 253;
          return <rect key={i} x={i} y={52 - hgt} width="1" height={hgt}
                       fill={edge ? 'var(--warn)' : 'var(--accent)'} opacity={edge ? 0.9 : 0.65}/>;
        })}
      </svg>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, fontSize: 11 }}>
        <Readout label={t('cameraParams.clipHigh')} value={`${(high * 100).toFixed(1)}%`} color={clipColor(high)}/>
        <Readout label={t('cameraParams.clipLow')} value={`${(low * 100).toFixed(1)}%`} color={clipColor(low)}/>
        <Readout label={t('cameraParams.meanLuma')} value={mean.toFixed(0)} color="var(--text)"/>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-3)' }}>
          <span>{t('cameraParams.sharpness')}</span>
          <span className="mono" style={{ color: 'var(--text)' }}>{sharpness.toFixed(0)}</span>
        </div>
        {/* Focus trend: the absolute number means little across scenes, but its
            PEAK is exactly what you hunt for when turning a focus ring. */}
        <svg width="100%" height="26" preserveAspectRatio="none"
             viewBox={`0 0 ${Math.max(2, TREND_POINTS)} 26`}
             style={{ background: 'var(--surface-2)', border: '1px solid var(--border-soft)' }}>
          <polyline fill="none" stroke="var(--ok)" strokeWidth="1"
                    points={trend.map((v, i) => `${i},${26 - (v / trendMax) * 24}`).join(' ')}/>
        </svg>
      </div>
    </div>
  );
}

function Readout({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, color }}>{value}</div>
    </div>
  );
}
