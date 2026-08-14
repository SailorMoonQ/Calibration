import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Section, Field } from '../components/primitives.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { useCameraSource, CameraSourcePanel } from '../components/CameraSource.jsx';
import { confirm } from '../components/confirm.jsx';
import { analyzeOpticalCenter, roiFor } from '../lib/opticalCenter.js';
import { edgeClipping } from '../lib/imageStats.js';
import { api, pickOpenFile } from '../api/client.js';

// Stroke a path twice — a dark underlay, then the colour on top — so a thin
// marker stays readable over both a blown-out calibration board and a dark
// scene. Same technique the fisheye guidance overlay uses.
//
// Deliberately NOT sampling the frame to pick a colour: the picture moves, so a
// background-adaptive marker would flicker on its own and could shift hue right
// at the boundary it is meant to mark. A fixed colour with its own contrast is
// steadier and cheaper.
function strokeContrast(ctx, draw, color, width) {
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'oklch(0.15 0 0 / 0.65)';
  ctx.lineWidth = width * 2.4;
  draw();
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  draw();
  ctx.stroke();
}

// Optical-centre and field-of-view alignment.
//
// The principal point (cx, cy) from a calibration is almost never at the frame
// centre — assembly tolerance shifts it by tens or hundreds of pixels. This tab
// makes that visible and, optionally, crops the stream so the optical axis lands
// dead centre.
//
// The crop is a PRE-CALIBRATION step: rough-calibrate → read cx,cy here → apply
// the ROI → calibrate again. Everything downstream then works on the cropped
// stream, so there is never a mix of old and new intrinsics.
export function RoiFovTab() {
  const { t } = useTranslation();
  const cam = useCameraSource({ pollEnabled: true });
  const { liveDevice, streamInfo } = cam;

  const [K, setK] = useState(null);
  const [loadedFrom, setLoadedFrom] = useState('');
  const [loadedRms, setLoadedRms] = useState(null);
  const [roiInfo, setRoiInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatusMsg] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const setStatus = (m, e = false) => { setStatusMsg(m); setStatusErr(e); };
  const [wantW, setWantW] = useState('');
  const [wantH, setWantH] = useState('');

  const overlayRef = useRef(null);
  const canvasHolder = useRef(null);
  const onCanvas = useCallback((ref) => { canvasHolder.current = ref ?? null; }, []);

  // Pulled out as plain values first: an optional-chained expression inside a
  // dependency array cannot be statically checked, so the memo would be dropped.
  const streamOpen = !!streamInfo?.open;
  const streamW = streamInfo?.width ?? 0;
  const streamH = streamInfo?.height ?? 0;
  // The UNCROPPED frame size. `streamInfo` reports the size consumers receive,
  // which is already cropped once an ROI is live — computing a new ROI from that
  // would treat the crop as if it were the whole sensor and walk the window off
  // target a little further with every adjustment. The backend reports the
  // pre-crop size for exactly this reason.
  const srcW = roiInfo?.source_size?.[0] ?? 0;
  const srcH = roiInfo?.source_size?.[1] ?? 0;
  const size = useMemo(() => {
    if (srcW && srcH) return [srcW, srcH];
    return streamOpen && streamW && streamH ? [streamW, streamH] : null;
  }, [srcW, srcH, streamOpen, streamW, streamH]);

  const refreshRoi = useCallback(async (device) => {
    if (!device) { setRoiInfo(null); return; }
    try { setRoiInfo(await api.cameraRoi(device)); }
    catch (e) { setStatus(t('roi.loadFailed', { error: e.message }), true); }
  }, [t]);

  useEffect(() => { refreshRoi(liveDevice); }, [liveDevice, refreshRoi]);

  const activeRoiApplied = !!roiInfo?.live_roi?.applied;

  // Whether the lens's image circle runs off an edge of the sensor. Sampled from
  // the preview rather than computed from K, because it is a property of the
  // optics-plus-sensor pairing that no calibration reports: a lens can be
  // perfectly centred and still overrun the sensor. Unlike a principal-point
  // offset, a clipped edge means field of view is genuinely GONE — no crop
  // recovers pixels the sensor never received.
  const [edges, setEdges] = useState(null);
  useEffect(() => {
    if (!liveDevice || activeRoiApplied) { setEdges(null); return undefined; }
    let stopped = false;
    let timer = null;
    const tick = () => {
      if (stopped) return;
      const c = canvasHolder.current?.current;
      if (c && c.width > 0 && c.height > 0) {
        try {
          const ctx = c.getContext('2d', { willReadFrequently: true });
          const img = ctx.getImageData(0, 0, c.width, c.height);
          setEdges(edgeClipping(img.data, c.width, c.height));
        } catch { /* canvas not painted yet — try again next tick */ }
      }
      timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 600);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [liveDevice, activeRoiApplied]);

  // Only meaningful when there IS a vignette to reason about. A rectilinear lens
  // filling the whole sensor lights every edge, and calling that "clipped on all
  // four sides" would be alarming and wrong.
  const clippedEdges = edges && edges.anyVignette ? edges.edges : [];

  // The analysis is only meaningful once we have BOTH a calibration and the size
  // of the frames it was measured on. Missing either yields null, and the panel
  // says what is missing instead of drawing a made-up principal point.
  const analysis = useMemo(() => (K && size ? analyzeOpticalCenter(K, size) : null), [K, size]);

  const proposed = useMemo(() => {
    if (!analysis) return null;
    const w = parseInt(wantW, 10);
    const h = parseInt(wantH, 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return roiFor(K, size, w, h);
    }
    return analysis.roi;
  }, [analysis, wantW, wantH, K, size]);

  // Draw centre cross, principal point, and the proposed crop box on an overlay
  // sized to the frame, so it lines up through object-fit letterboxing.
  useEffect(() => {
    const c = overlayRef.current;
    if (!c || !size) return;
    const [w, h] = size;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const unit = Math.max(2, Math.round(Math.min(w, h) / 240));

    // Geometric frame centre — a white reticle, drawn with its own dark underlay
    // so it reads on any background. White is used because this is the neutral
    // REFERENCE; amber is reserved for the measured principal point and the
    // proposed crop, so the two never compete for the same meaning.
    //
    const armOuter = Math.max(18, Math.min(w, h) * 0.055);
    const cw = Math.max(2, unit * 0.95);
    strokeContrast(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(w / 2 - armOuter, h / 2); ctx.lineTo(w / 2 + armOuter, h / 2);
      ctx.moveTo(w / 2, h / 2 - armOuter); ctx.lineTo(w / 2, h / 2 + armOuter);
    }, 'oklch(0.97 0 0 / 0.95)', cw);

    if (!analysis) return;
    // Once a crop is live the preview shows the cropped picture, so drawing the
    // full-frame geometry on top of it would misplace every marker. Show the
    // overlay only while the preview and the analysis share a coordinate system.
    if (activeRoiApplied) return;
    const cx = K[0][2], cy = K[1][2];

    // Proposed crop: dashed box, everything outside dimmed, so the cost of the
    // crop is visible rather than described.
    if (proposed && proposed.width > 0) {
      ctx.save();
      ctx.fillStyle = 'oklch(0.1 0 0 / 0.45)';
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.rect(proposed.left, proposed.top, proposed.width, proposed.height);
      ctx.fill('evenodd');
      ctx.setLineDash([unit * 3, unit * 3]);
      ctx.strokeStyle = 'oklch(0.9 0.18 90 / 0.9)';
      ctx.lineWidth = Math.max(1.5, unit * 0.6);
      ctx.strokeRect(proposed.left, proposed.top, proposed.width, proposed.height);
      ctx.restore();
    }

    // Connector from the frame centre to the principal point — it is the offset
    // being reported, so showing it as a line makes the magnitude readable
    // without looking at the numbers. Skipped when the two nearly coincide,
    // where a stub line would just be visual noise.
    const rDot = Math.max(3, Math.min(w, h) * 0.008);
    if (Math.hypot(cx - w / 2, cy - h / 2) > rDot * 2) {
      strokeContrast(ctx, () => {
        ctx.beginPath();
        ctx.moveTo(w / 2, h / 2);
        ctx.lineTo(cx, cy);
      }, 'oklch(0.9 0.18 90 / 0.9)', Math.max(1.5, unit * 0.55));
    }

    // Principal point — a filled dot inside a ring. A different SHAPE from the
    // centre reticle, not just a different colour, so the two stay tellable
    // apart when they overlap and for anyone who cannot separate them by hue.
    strokeContrast(ctx, () => {
      ctx.beginPath();
      ctx.arc(cx, cy, rDot * 2.6, 0, Math.PI * 2);
    }, 'oklch(0.92 0.18 90 / 0.95)', Math.max(1.5, unit * 0.6));
    ctx.fillStyle = 'oklch(0.15 0 0 / 0.65)';
    ctx.beginPath(); ctx.arc(cx, cy, rDot * 1.35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'oklch(0.92 0.18 90 / 0.98)';
    ctx.beginPath(); ctx.arc(cx, cy, rDot, 0, Math.PI * 2); ctx.fill();
  }, [analysis, proposed, size, K, activeRoiApplied]);

  const onLoad = async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      if (!d.K) { setStatus(t('roi.noKInFile'), true); return; }
      setK(d.K);
      setLoadedFrom(p.split('/').pop());
      setLoadedRms(typeof d.rms === 'number' ? d.rms : null);
      setStatus('');
    } catch (e) {
      setStatus(t('roi.loadCalibFailed', { error: e.message }), true);
    }
  };

  const onApply = async () => {
    if (!liveDevice || !proposed) return;
    const ok = await confirm({
      message: t('roi.confirmApply', {
        w: proposed.width, h: proposed.height,
        lost: analysis?.loss ? (analysis.loss.lost * 100).toFixed(0) : '0',
      }),
      confirmLabel: t('roi.apply'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      // Record the frame size this crop was measured on. Without it the backend
      // cannot tell a valid crop from one left over from another resolution, and
      // would apply the stale one to the wrong part of the picture.
      const r = await api.setCameraRoi({ device: liveDevice, ...proposed, for_size: size });
      await refreshRoi(liveDevice);
      setStatus(r.applied ? t('roi.applied') : t('roi.savedNotApplied', { error: r.error }), !r.applied);
    } catch (e) {
      setStatus(t('roi.applyFailed', { error: e.message }), true);
    } finally { setBusy(false); }
  };

  const onClear = async () => {
    if (!liveDevice) return;
    setBusy(true);
    try {
      await api.setCameraRoi({ device: liveDevice, clear: true });
      await refreshRoi(liveDevice);
      setStatus(t('roi.cleared'));
    } catch (e) {
      setStatus(t('roi.applyFailed', { error: e.message }), true);
    } finally { setBusy(false); }
  };

  const activeRoi = roiInfo?.roi ?? null;
  const hwCrop = roiInfo?.hw_crop;
  // The stored crop does not match the current frame size, so the backend is
  // deliberately not applying it. Saying so beats a preview that silently
  // ignores a crop the panel claims is active.
  const roiStale = !!roiInfo?.stale;

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>{t('roi.railTitle')}</span>
          <span className="mono" style={{ color: activeRoi ? 'var(--warn)' : 'var(--text-4)' }}>
            {activeRoi ? `${activeRoi.width}×${activeRoi.height}` : t('common.idle')}
          </span>
        </div>
        <div className="rail-scroll">
          <CameraSourcePanel source={cam}/>

          <Section title={t('roi.calibration')} hint={loadedFrom || t('roi.notLoaded')}>
            <button className="btn" style={{ width: '100%' }} onClick={onLoad}>
              {t('roi.loadCalib')}
            </button>
            {loadedRms != null && (
              <div className="mono" style={{ fontSize: 10.5, marginTop: 6,
                     color: loadedRms > 1 ? 'var(--warn)' : 'var(--text-3)' }}>
                rms {loadedRms.toFixed(3)} px
                {loadedRms > 1 && ` · ${t('roi.rmsHigh')}`}
              </div>
            )}
            {!K && (
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
                {t('roi.needCalibration')}
              </div>
            )}
          </Section>

          {roiStale && (
            <Section title={t('roi.roiStaleTitle')}>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--err)', lineHeight: 1.5 }}>
                {t('roi.roiStale', {
                  was: (activeRoi?.for_size || []).join('×'),
                  now: (roiInfo?.size || []).join('×'),
                })}
              </div>
              <button className="btn ghost" style={{ width: '100%', marginTop: 6 }}
                      disabled={busy} onClick={onClear}>{t('roi.clear')}</button>
            </Section>
          )}

          {activeRoiApplied && (
            <Section title={t('roi.roiActive')}>
              <div style={{ fontSize: 10.5, color: 'var(--warn)', lineHeight: 1.5 }}>
                {t('roi.overlayHiddenCropped')}
              </div>
              <button className="btn ghost" style={{ width: '100%', marginTop: 6 }}
                      disabled={busy} onClick={onClear}>{t('roi.clear')}</button>
            </Section>
          )}

          {clippedEdges.length > 0 && (
            <Section title={t('roi.circleClipped')} hint={String(clippedEdges.length)}>
              <div style={{ fontSize: 11, color: 'var(--warn)', lineHeight: 1.55 }}>
                {t('roi.circleClippedBody', {
                  edges: clippedEdges.map(e => t(`roi.edge.${e}`)).join('、'),
                })}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
                {t('roi.circleClippedNote')}
              </div>
            </Section>
          )}

          <Section title={t('roi.hwCrop')}>
            <div className="mono" style={{ fontSize: 10.5, lineHeight: 1.5,
                   color: hwCrop?.supported ? 'var(--ok)' : 'var(--text-3)' }}>
              {hwCrop == null ? '—'
                : hwCrop.supported ? t('roi.hwCropYes') : t('roi.hwCropNo')}
            </div>
          </Section>

          {analysis && (
            <Section title={t('roi.cropWindow')} hint={proposed ? `${proposed.width}×${proposed.height}` : ''}>
              <Field label={t('roi.customSize')}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input className="input mono" style={{ width: 62 }} type="number" placeholder="w"
                         value={wantW} onChange={e => setWantW(e.target.value)}/>
                  <span style={{ color: 'var(--text-3)' }}>×</span>
                  <input className="input mono" style={{ width: 62 }} type="number" placeholder="h"
                         value={wantH} onChange={e => setWantH(e.target.value)}/>
                  <button className="btn ghost" style={{ fontSize: 10 }}
                          onClick={() => { setWantW(''); setWantH(''); }}>
                    {t('roi.useMax')}
                  </button>
                </div>
              </Field>
              {proposed?.clamped && (
                <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 4 }}>
                  {t('roi.clamped', { w: proposed.width, h: proposed.height })}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
                <button className="btn primary" disabled={busy || !proposed?.width} onClick={onApply}>
                  {t('roi.apply')}
                </button>
                <button className="btn ghost" disabled={busy || !activeRoi} onClick={onClear}>
                  {t('roi.clear')}
                </button>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 8, lineHeight: 1.5 }}>
                {t('roi.recalibrateNote')}
              </div>
            </Section>
          )}

          {status && (
            <Section title={t('roi.status')}>
              <div className="mono" style={{ fontSize: 10.5, lineHeight: 1.5,
                     color: statusErr ? 'var(--err)' : 'var(--text-3)' }}>{status}</div>
            </Section>
          )}
        </div>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <div className="spacer"/>
          <div className="read">
            {streamInfo?.open && <>{streamInfo.width}×{streamInfo.height} · </>}
            {roiStale
              ? <b style={{ color: 'var(--err)' }}>{t('roi.roiStaleShort')}</b>
              : activeRoi
                ? <b style={{ color: 'var(--warn)' }}>{t('roi.roiActive')}</b>
                : t('roi.roiOff')}
          </div>
        </div>
        <div className="vp-body vp-split" style={{ gridTemplateColumns: '1fr' }}>
          <div className="vp-cell" style={{ position: 'relative' }}>
            <span className="vp-label">
              {liveDevice ? t('roi.liveLabel', { device: liveDevice }) : t('roi.noCamera')}
            </span>
            {liveDevice
              ? <>
                  <LivePreview device={liveDevice} onCanvas={onCanvas}/>
                  <canvas ref={overlayRef}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                                   objectFit: 'contain', pointerEvents: 'none' }}/>
                </>
              : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                              width: '100%', height: '100%', color: 'var(--view-text-2)',
                              fontFamily: 'JetBrains Mono', fontSize: 11 }}>
                  {t('roi.pickCamera')}
                </div>}
          </div>
        </div>
      </div>

      <div className="rail">
        <div className="rail-header"><span>{t('roi.readout')}</span></div>
        <div className="rail-scroll">
          {!analysis && (
            <Section title={t('roi.readout')}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6 }}>
                {!K ? t('roi.needCalibration') : t('roi.needStream')}
              </div>
            </Section>
          )}

          {analysis && (
            <>
              <Section title={t('roi.offset')}>
                <Row label="dx" value={`${analysis.offset.dx.toFixed(1)} px`}
                     hint={`${(analysis.offset.fracX * 100).toFixed(1)}%`}/>
                <Row label="dy" value={`${analysis.offset.dy.toFixed(1)} px`}
                     hint={`${(analysis.offset.fracY * 100).toFixed(1)}%`}/>
                <Row label={t('roi.distance')} value={`${analysis.offset.distance.toFixed(1)} px`}/>
              </Section>

              <Section title={t('roi.fovNow')}>
                <Row label="H" value={`${analysis.fov.horizontal.toFixed(1)}°`}/>
                <Row label="V" value={`${analysis.fov.vertical.toFixed(1)}°`}/>
                <Row label="D" value={`${analysis.fov.diagonal.toFixed(1)}°`}/>
              </Section>

              <Section title={t('roi.afterCrop')} hint={proposed ? `${proposed.width}×${proposed.height}` : ''}>
                <Row label="H" value={`${(analysis.fovAfter?.horizontal ?? 0).toFixed(1)}°`}/>
                <Row label="V" value={`${(analysis.fovAfter?.vertical ?? 0).toFixed(1)}°`}/>
                <Row label={t('roi.frameLoss')}
                     value={`${((analysis.loss?.lost ?? 0) * 100).toFixed(1)}%`}
                     color={(analysis.loss?.lost ?? 0) > 0.25 ? 'var(--warn)' : 'var(--text)'}/>
              </Section>

              <Section title={t('roi.kAfter')}>
                <div className="mono" style={{ fontSize: 11, display: 'grid',
                       gridTemplateColumns: '1fr 1fr', gap: '3px 10px' }}>
                  <span style={{ color: 'var(--text-3)' }}>fx</span>
                  <span style={{ textAlign: 'right' }}>{analysis.kAfter[0][0].toFixed(2)}</span>
                  <span style={{ color: 'var(--text-3)' }}>fy</span>
                  <span style={{ textAlign: 'right' }}>{analysis.kAfter[1][1].toFixed(2)}</span>
                  <span style={{ color: 'var(--warn)' }}>cx′</span>
                  <span style={{ textAlign: 'right', color: 'var(--warn)' }}>{analysis.kAfter[0][2].toFixed(2)}</span>
                  <span style={{ color: 'var(--warn)' }}>cy′</span>
                  <span style={{ textAlign: 'right', color: 'var(--warn)' }}>{analysis.kAfter[1][2].toFixed(2)}</span>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
                  {t('roi.kNote')}
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, hint, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11.5, marginBottom: 3 }}>
      <span style={{ color: 'var(--text-3)', flex: 1 }}>{label}</span>
      {hint && <span className="mono" style={{ fontSize: 10, color: 'var(--text-4)' }}>{hint}</span>}
      <span className="mono" style={{ color: color || 'var(--text)' }}>{value}</span>
    </div>
  );
}
