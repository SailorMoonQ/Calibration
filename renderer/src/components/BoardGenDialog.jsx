import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field, Seg, NumInput } from './primitives.jsx';
import { TargetPanel } from './panels.jsx';
import { DEFAULT_BOARD } from '../lib/board.js';
import { actualSquareMm, printedSizeMm, squareCount } from '../lib/boardgen.js';
import { exportBoard, fetchBoardPreviewBlob, openPath, pickSaveFile } from '../api/client.js';

const PAPERS = ['A4', 'A3', 'A2', 'A1', 'A0', 'Letter'];
const DPIS = [150, 300, 600];
const PREVIEW_MAX_PX = 1600;

// A2, not A4: the shipped default board is 11 x 8 at 45 mm, which is 495 x 360 mm
// of ink — it clears A2 landscape and nothing smaller, so any lesser default
// would greet everyone with a "does not fit" refusal on open.
const DEFAULT_PRINT = { dpi: 300, paper: 'A2', marginMm: 10 };

export function BoardGenDialog({ open, onClose }) {
  const { t } = useTranslation();
  const [board, setBoard] = useState(() => ({ ...DEFAULT_BOARD }));
  const [print, setPrint] = useState(() => ({ ...DEFAULT_PRINT }));
  const [mode, setMode] = useState('page');
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // Re-render the preview whenever anything that changes the sheet changes. The
  // blob URL is revoked on the way out so a long parameter-fiddling session
  // doesn't leak a few hundred rasters.
  useEffect(() => {
    if (!open) return undefined;
    let url = '';
    let cancelled = false;
    fetchBoardPreviewBlob(board, { ...print, mode, maxPx: PREVIEW_MAX_PX })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
        setError('');
      })
      .catch((e) => { if (!cancelled) { setSrc(''); setError(e.message); } });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [open, board, print, mode]);

  if (!open) return null;

  const squareMm = actualSquareMm(board.sq, print.dpi);
  const size = printedSizeMm(board, print.dpi);
  const { x, y } = squareCount(board);
  const markerCount = board.type === 'charuco' ? Math.floor((x * y) / 2) : 0;
  const innerCorners = board.type === 'charuco' ? (x - 1) * (y - 1) : board.cols * board.rows;

  const save = async (format) => {
    const path = await pickSaveFile({
      defaultPath: `charuco_${board.cols}x${board.rows}_${squareMm.toFixed(1)}mm.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    setBusy(true);
    setError('');
    try {
      const res = await exportBoard(board, { ...print, mode, maxPx: 0 }, { format, path });
      setSaved(res.path);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true">
        <div className="modal-title">{t('boardgen.title')}</div>
        <div className="boardgen">
          <div className="boardgen-side">
            <TargetPanel board={board} onBoard={setBoard}/>
            <div className="boardgen-print">
              <Field label={t('boardgen.paper')}>
                <select className="select" value={print.paper}
                        onChange={e => setPrint({ ...print, paper: e.target.value })}>
                  {PAPERS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label={t('boardgen.dpi')}>
                <Seg value={print.dpi} onChange={v => setPrint({ ...print, dpi: v })} full
                     options={DPIS.map(d => ({ value: d, label: String(d) }))}/>
              </Field>
              <Field label={t('boardgen.margin')}>
                <NumInput value={print.marginMm} step={1}
                          onChange={v => setPrint({ ...print, marginMm: v })} suffix="mm"/>
              </Field>
            </div>
            <div className="boardgen-facts">
              <div><span>{t('boardgen.printedSize')}</span>
                   <b>{size.w.toFixed(1)} × {size.h.toFixed(1)} mm</b></div>
              <div><span>{t('boardgen.actualSquare')}</span>
                   <b>{squareMm.toFixed(3)} mm</b></div>
              <div><span>{t('boardgen.innerCorners')}</span><b>{innerCorners}</b></div>
              {markerCount > 0 && (
                <div><span>{t('boardgen.markers')}</span><b>{markerCount}</b></div>
              )}
            </div>
            <p className="boardgen-note">{t('boardgen.scaleWarning')}</p>
            <p className="boardgen-note">{t('boardgen.legacyWarning')}</p>
          </div>

          <div className="boardgen-preview">
            <Seg value={mode} onChange={setMode} full options={[
              { value: 'page', label: t('boardgen.modePage') },
              { value: 'board', label: t('boardgen.modeBoard') },
            ]}/>
            <div className="boardgen-canvas">
              {error
                ? <div className="boardgen-error">{error}</div>
                : src
                  ? <img src={src} alt={t('boardgen.title')}/>
                  : <div className="boardgen-empty">…</div>}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          {saved && (
            <button className="btn ghost" onClick={() => openPath(saved)}>
              {t('boardgen.openSaved')}
            </button>
          )}
          <span className="spacer"/>
          <button className="btn" onClick={onClose}>{t('common.close')}</button>
          <button className="btn" disabled={busy || !!error} onClick={() => save('png')}>
            {t('boardgen.savePng')}
          </button>
          <button className="btn primary" disabled={busy || !!error} onClick={() => save('pdf')}>
            {t('boardgen.savePdf')}
          </button>
        </div>
      </div>
    </div>
  );
}
