import React, { useState, useEffect } from 'react';

// Editable "WxH" field shared by the resolution and clip rows on the live source
// panel. While the user is typing we hold off on syncing from the 1Hz info poll
// so the value doesn't flicker mid-edit; commit fires on Enter or blur. The
// backend can take a moment (camera restart for resolution, immediate for clip),
// so we keep editing=true across the await — otherwise the poll could overwrite
// the in-flight value with the still-stale "before" size. `options` populates a
// <datalist> so the field doubles as a dropdown of advertised modes; `allowOff`
// lets the user clear the value with "off" / empty / 0, used by the clip row.
export function SizeInput({ value, onCommit, options, allowOff, title, listId }) {
  const formatted = value ? `${value[0]}×${value[1]}` : 'off';
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(formatted);
  }, [formatted, editing]);

  const commit = async () => {
    const raw = draft.trim();
    const isOff = allowOff && /^(off|none|0|0\s*[x×*]\s*0)$/i.test(raw.replace(/\s+/g, ''));
    if (isOff) {
      if (value === null) { setEditing(false); return; }
      setPending(true);
      try { await onCommit(0, 0); }
      catch (_) {}
      finally { setPending(false); setEditing(false); }
      return;
    }
    const m = raw.replace(/\s+/g, '').match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
    if (!m) { setDraft(formatted); setEditing(false); return; }
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (!(w > 0 && h > 0)) { setDraft(formatted); setEditing(false); return; }
    if (value && w === value[0] && h === value[1]) { setEditing(false); return; }
    setPending(true);
    try {
      await onCommit(w, h);
    } catch (_) {
      // Drop back to what the source actually reports — the next poll will sync.
    } finally {
      setPending(false);
      setEditing(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        className="input mono"
        list={options?.length ? listId : undefined}
        style={{
          height: 18, padding: '1px 5px', fontSize: 11, width: 96,
          color: pending ? 'var(--text-3)' : 'var(--text-1)',
        }}
        value={draft}
        disabled={pending}
        onFocus={() => setEditing(true)}
        onChange={e => { setEditing(true); setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.target.blur();
          else if (e.key === 'Escape') { setDraft(formatted); setEditing(false); e.target.blur(); }
        }}
        title={title}
      />
      {options?.length ? (
        <datalist id={listId}>
          {options.map(([w, h]) => (
            <option key={`${w}x${h}`} value={`${w}×${h}`}/>
          ))}
        </datalist>
      ) : null}
    </span>
  );
}
