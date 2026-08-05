import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// One V4L2 control, rendered by its type. Int → slider + numeric box, bool →
// checkbox, menu → dropdown.
//
// The interesting case is `inactive`: V4L2 reports that a control is currently
// unwritable (exposure time while auto-exposure is on) but not which control
// holds the lock. The backend infers the parent; here we surface it, because a
// slider that silently does nothing is the single most confusing thing a camera
// panel can do. When the parent is known we offer to release the lock in one
// click instead of making the operator hunt for it.
export function ControlWidget({ control, onSet, onUnlock, busy }) {
  const { t } = useTranslation();
  const { id, type, min, max, step, value, inactive, locked_by: lockedBy } = control;

  // Local echo so dragging feels immediate; the authoritative value comes back
  // from the driver on the next refresh.
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);

  const label = t(`cameraParams.ctrl.${id}`, { defaultValue: id });
  const disabled = !!inactive || !!busy;

  const commit = (v) => {
    setLocal(v);
    onSet(id, v);
  };

  return (
    <div style={{ opacity: inactive ? 0.55 : 1, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-2)', flex: 1 }}>{label}</span>
        {type !== 'bool' && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{local}</span>
        )}
      </div>

      {type === 'int' && (
        <div className="slider-row">
          <input type="range" min={min} max={max} step={step || 1}
                 value={local ?? min ?? 0} disabled={disabled}
                 onChange={e => setLocal(+e.target.value)}
                 onMouseUp={e => commit(+e.target.value)}
                 onKeyUp={e => commit(+e.target.value)}
                 onTouchEnd={e => commit(+e.target.value)}/>
          <input className="input mono" style={{ width: 66, fontSize: 11 }}
                 type="number" min={min} max={max} step={step || 1}
                 value={local ?? ''} disabled={disabled}
                 onChange={e => setLocal(e.target.value === '' ? '' : +e.target.value)}
                 onBlur={e => e.target.value !== '' && commit(+e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter' && e.target.value !== '') commit(+e.target.value); }}/>
        </div>
      )}

      {type === 'bool' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, cursor: disabled ? 'default' : 'pointer' }}>
          <input type="checkbox" checked={!!local} disabled={disabled}
                 onChange={e => commit(e.target.checked ? 1 : 0)}/>
          <span style={{ color: 'var(--text-3)' }}>{local ? t('cameraParams.on') : t('cameraParams.off')}</span>
        </label>
      )}

      {type === 'menu' && (
        <select className="input" style={{ width: '100%', fontSize: 11.5 }}
                value={local ?? ''} disabled={disabled}
                onChange={e => commit(+e.target.value)}>
          {(control.menu || []).map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}

      {inactive && (
        <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
          {lockedBy ? (
            <>
              <span>{t('cameraParams.lockedBy', {
                parent: t(`cameraParams.ctrl.${lockedBy.id}`, { defaultValue: lockedBy.id }),
              })}</span>
              <button className="btn" style={{ padding: '1px 6px', fontSize: 10 }}
                      disabled={busy}
                      onClick={() => onUnlock(lockedBy.id, lockedBy.unlock_value)}>
                {t('cameraParams.unlock')}
              </button>
            </>
          ) : (
            <span>{t('cameraParams.lockedUnknown')}</span>
          )}
        </div>
      )}
    </div>
  );
}
