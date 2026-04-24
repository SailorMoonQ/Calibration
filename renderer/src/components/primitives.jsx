import React from 'react';

export function Field({ label, children, hint }) {
  return (
    <div className="field" title={hint}>
      <label>{label}</label>
      <div className="control">{children}</div>
    </div>
  );
}

export function Section({ title, hint, children, right }) {
  return (
    <div className="section">
      <div className="section-head">
        <span>{title}{hint && <span className="hint"> · {hint}</span>}</span>
        {right}
      </div>
      <div className="section-body">{children}</div>
    </div>
  );
}

export function Seg({ value, onChange, options, full }) {
  return (
    <div className={"seg" + (full ? " full" : "")}>
      {options.map(o => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return (
          <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>
        );
      })}
    </div>
  );
}

export function Chk({ checked, onChange, children }) {
  return (
    <label className="chk">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function NumInput({ value, onChange, step = 0.01, suffix, width }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
      <input
        className="input num"
        type="number"
        value={value}
        step={step}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: width || '100%' }}
      />
      {suffix && <span style={{ color: 'var(--text-4)', fontSize: 10.5 }}>{suffix}</span>}
    </div>
  );
}

export function KV({ items }) {
  return (
    <dl className="kv">
      {items.map(([k, v, cls], i) => (
        <React.Fragment key={i}>
          <dt>{k}</dt>
          <dd className={cls || ''}>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Matrix({ m, label }) {
  return (
    <div>
      {label && <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>}
      <div className="matrix">
        {m.flat().map((v, i) => (
          <span key={i} className={(i % 4 === 3 && Math.floor(i/4) === 3) || (i >= 12 && i < 15) ? 'muted' : ''}>
            {typeof v === 'number' ? v.toFixed(4) : v}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Pill({ status = 'idle', children }) {
  return <span className={"pill " + status}><span className="dot"/>{children}</span>;
}

export function Spark({ data, w = 200, h = 44, color = 'var(--accent)', threshold, yLabel }) {
  if (!data || !data.length) return null;
  const min = 0;
  const max = Math.max(...data, threshold || 0) * 1.15 || 1;
  const px = w - 4, py = h - 10;
  const step = px / (data.length - 1 || 1);
  const points = data.map((v, i) => [2 + i * step, 4 + py - (v - min) / (max - min) * py]);
  const d = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const ty = threshold != null ? 4 + py - (threshold - min) / (max - min) * py : null;
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <rect x="0" y="0" width={w} height={h} fill="transparent"/>
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1="2" x2={w-2} y1={4 + py * f} y2={4 + py * f} stroke="var(--border-soft)" strokeDasharray="2 3"/>
      ))}
      {ty != null && (
        <>
          <line x1="2" x2={w-2} y1={ty} y2={ty} stroke="var(--warn)" strokeDasharray="3 3" strokeWidth="1"/>
          <text x={w-4} y={ty - 2} fontSize="9" fill="var(--warn)" textAnchor="end" fontFamily="JetBrains Mono">thresh {threshold}</text>
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.25"/>
      {points.map((p, i) => i === points.length - 1 && (
        <circle key={i} cx={p[0]} cy={p[1]} r="2.5" fill={color}/>
      ))}
      <text x="2" y={h - 1} fontSize="9" fill="var(--text-4)" fontFamily="JetBrains Mono">0</text>
      <text x="2" y="9" fontSize="9" fill="var(--text-4)" fontFamily="JetBrains Mono">{max.toFixed(2)}{yLabel ? ' ' + yLabel : ''}</text>
    </svg>
  );
}

export function Histogram({ data, bins = 20, w = 280, h = 60, color = 'var(--accent)' }) {
  const counts = Array(bins).fill(0);
  const max = Math.max(...data);
  data.forEach(v => {
    const b = Math.min(bins - 1, Math.floor(v / max * bins));
    counts[b]++;
  });
  const cmax = Math.max(...counts);
  const bw = (w - 4) / bins;
  return (
    <svg width={w} height={h}>
      {counts.map((c, i) => {
        const bh = (c / cmax) * (h - 14);
        return <rect key={i} x={2 + i * bw} y={h - 10 - bh} width={bw - 1} height={bh} fill={color} opacity={0.8}/>;
      })}
      <line x1="0" x2={w} y1={h-10} y2={h-10} stroke="var(--border)"/>
      <text x="2" y={h - 1} fontSize="9" fill="var(--text-4)" fontFamily="JetBrains Mono">0</text>
      <text x={w-2} y={h - 1} fontSize="9" fill="var(--text-4)" fontFamily="JetBrains Mono" textAnchor="end">{max.toFixed(2)} px</text>
    </svg>
  );
}

export function AxisGlyph({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22">
      <line x1="11" y1="11" x2="20" y2="11" stroke="var(--axis-x)" strokeWidth="1.5"/>
      <line x1="11" y1="11" x2="11" y2="2" stroke="var(--axis-y)" strokeWidth="1.5"/>
      <line x1="11" y1="11" x2="4" y2="18" stroke="var(--axis-z)" strokeWidth="1.5"/>
      <circle cx="11" cy="11" r="1.2" fill="var(--text)"/>
    </svg>
  );
}
