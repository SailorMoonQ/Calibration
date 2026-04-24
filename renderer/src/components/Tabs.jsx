import React from 'react';

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map(t => (
        <button key={t.id}
          className={"tab" + (value === t.id ? ' active' : '')}
          onClick={() => onChange(t.id)}>
          <span className="tnum">{t.num}</span>
          <span>{t.label}<span style={{color: 'var(--text-4)', fontWeight: 400}}> · {t.sub}</span></span>
          <span className={"badge " + t.badge}>{t.badge === 'ok' ? '✓' : t.badge === 'warn' ? '!' : '×'}</span>
        </button>
      ))}
      <span style={{ flex: 1 }}/>
      <button className="tab" style={{ color: 'var(--text-3)', fontSize: 11.5 }}>+ add stage</button>
    </div>
  );
}
