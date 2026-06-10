import { useEffect, useRef, useState } from 'react';

// Promise-based, theme-aware replacement for window.confirm(). Mount <ConfirmHost/>
// once near the app root; call `await confirm({ message, confirmLabel, cancelLabel })`
// from anywhere — it resolves true on confirm, false on cancel/dismiss.
let openConfirm = null;

export function confirm(opts) {
  return new Promise((resolve) => {
    if (!openConfirm) { resolve(false); return; }
    openConfirm({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [state, setState] = useState(null);
  const okRef = useRef(null);

  const done = (v) => { state?.resolve(v); setState(null); };

  useEffect(() => {
    openConfirm = (s) => setState(s);
    return () => { openConfirm = null; };
  }, []);

  useEffect(() => {
    if (!state) return;
    okRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!state) return null;
  const danger = state.danger !== false;  // default to a destructive (red) confirm

  return (
    <div className="modal-overlay" onMouseDown={() => done(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {state.title && <div className="modal-title">{state.title}</div>}
        <div className="modal-body">{state.message}</div>
        <div className="modal-actions">
          <button className="btn" onClick={() => done(false)}>{state.cancelLabel || 'Cancel'}</button>
          <button ref={okRef} className={"btn " + (danger ? 'danger' : 'primary')} onClick={() => done(true)}>
            {state.confirmLabel || 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
