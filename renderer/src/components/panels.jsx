import React, { useEffect, useRef } from 'react';
import { Section, Seg, Field, Chk, KV, NumInput, Spark, Histogram } from './primitives.jsx';

function FrameThumb({ f }) {
  return (
    <svg viewBox="0 0 58 42" width="58" height="42" preserveAspectRatio="none">
      <rect width="58" height="42" fill="#141a23"/>
      <g transform={`translate(${f.tx || 0}, ${f.ty || 0}) rotate(${(f.rot || 0) * 40} 29 21)`}>
        <rect x="18" y="13" width="22" height="16" fill="#c5cdd6" opacity="0.5"/>
        {[0,1,2,3].map(i => [0,1,2].map(j => (
          <rect key={i+'-'+j} x={18 + i*5} y={13 + j*5} width="5" height="5" fill={(i+j)%2 ? '#141a23' : '#c5cdd6'} opacity="0.55"/>
        )))}
      </g>
    </svg>
  );
}

export function FrameStrip({ frames, selected, onSelect, coverage }) {
  const activeRef = useRef(null);
  // Whenever the selection changes, slide the strip so the active thumb is centered.
  // `block: 'nearest'` keeps the page from also scrolling vertically.
  useEffect(() => {
    if (activeRef.current && typeof activeRef.current.scrollIntoView === 'function') {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [selected]);

  return (
    <div className="framestrip">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 110, fontSize: 10, color: 'var(--text-3)', fontFamily: 'JetBrains Mono' }}>
        <div>frames  <b style={{color: 'var(--text)'}}>{frames.length}</b> / 40</div>
        <div>coverage <b style={{color: 'var(--text)'}}>{coverage}%</b></div>
      </div>
      <div style={{ width: 1, height: 38, background: 'var(--border-soft)' }}/>
      {frames.map(f => {
        const isActive = selected === f.id;
        return (
          <div key={f.id}
               ref={isActive ? activeRef : null}
               className={"frame-thumb" + (isActive ? ' active' : '')}
               onClick={() => onSelect(f.id)}>
            <FrameThumb f={f}/>
            <span className="fnum">#{f.id.toString().padStart(2,'0')}</span>
            <span className="ferr" style={{ color: f.err > 0.6 ? 'oklch(0.75 0.17 25)' : f.err > 0.35 ? 'oklch(0.8 0.15 70)' : 'oklch(0.82 0.14 150)' }}>{f.err.toFixed(2)}</span>
            <span className="fbar" style={{ width: (1 - Math.min(1, f.err)) * 100 + '%', background: f.err > 0.6 ? 'var(--err)' : f.err > 0.35 ? 'var(--warn)' : 'var(--ok)' }}/>
          </div>
        );
      })}
      <button className="btn sm ghost" style={{ marginLeft: 4, flex: '0 0 auto' }}>+ add</button>
    </div>
  );
}

export function CoverageGrid({ cells, w = 110, h = 72 }) {
  const cols = 8, rows = 5;
  return (
    <svg width={w} height={h}>
      <rect width={w} height={h} fill="var(--surface-2)" stroke="var(--border-soft)"/>
      {Array.from({length: cols * rows}).map((_, idx) => {
        const i = idx % cols, j = Math.floor(idx / cols);
        const on = cells[idx];
        return (
          <rect key={idx}
                x={i * w/cols + 1} y={j * h/rows + 1}
                width={w/cols - 2} height={h/rows - 2}
                fill={on ? 'var(--accent)' : 'transparent'}
                opacity={on ? 0.45 : 1}
                stroke="var(--border)" strokeWidth="0.5"/>
        );
      })}
    </svg>
  );
}

export function ErrorPanel({ rms, frames, histData }) {
  const traffic = rms < 0.25 ? 'ok' : rms < 0.5 ? 'warn' : 'err';
  const trafficColor = traffic === 'ok' ? 'var(--ok)' : traffic === 'warn' ? 'var(--warn)' : 'var(--err)';
  return (
    <div>
      <Section title="Reprojection Error" hint="px">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'baseline', gap: 10 }}>
          <div>
            <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>RMS over frames</div>
            <div style={{ fontFamily: 'JetBrains Mono', fontSize: 24, fontWeight: 500, color: trafficColor, letterSpacing: '-0.02em' }}>{rms.toFixed(3)}<span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 4 }}>px</span></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--text-2)', textAlign: 'right' }}>
            <div>mean <b style={{color: 'var(--text)'}}>{(rms * 0.92).toFixed(3)}</b></div>
            <div>max  <b style={{color: 'var(--text)'}}>{(rms * 2.4).toFixed(3)}</b></div>
            <div>σ    <b style={{color: 'var(--text)'}}>{(rms * 0.41).toFixed(3)}</b></div>
          </div>
        </div>

        <div className="chart-wrap" style={{ marginTop: 8 }}>
          <div className="chart-title"><span>Per-frame RMS</span><b>{frames.length} frames</b></div>
          <Spark data={frames} w={280} h={46} color={trafficColor} threshold={0.5}/>
        </div>

        <div className="chart-wrap" style={{ marginTop: 6 }}>
          <div className="chart-title"><span>Residual distribution</span><b>{histData.length} corners</b></div>
          <Histogram data={histData} w={280} h={54} color={trafficColor}/>
        </div>
      </Section>
    </div>
  );
}

export function CaptureControls({
  live, onLive,
  autoCapture, onAuto,
  autoRate, onAutoRate,
  onSnap, onDrop,
  coverage, coverageCells,
}) {
  const rate = typeof autoRate === 'number' ? autoRate : 0.5;
  const fps = rate > 0 ? (1 / rate) : 0;
  return (
    <Section title="Capture" hint="live feed">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {onLive
          ? <Chk checked={live} onChange={onLive}>live stream</Chk>
          : <div/>}
        <Chk checked={autoCapture} onChange={onAuto}>auto-capture</Chk>
      </div>
      {autoCapture && onAutoRate && (
        <Field label={`auto rate · ${rate.toFixed(1)}s (≈${fps.toFixed(1)} fps)`}>
          <div className="slider-row">
            <input type="range" min="20" max="300" step="10"
                   value={Math.round(rate * 100)}
                   onChange={e => onAutoRate(+e.target.value / 100)}/>
            <span className="mono">{rate.toFixed(1)}s</span>
          </div>
        </Field>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <button className="btn" onClick={onSnap}>⌁ snap frame</button>
        <button className="btn danger" onClick={onDrop} disabled={!onDrop}>⌧ drop selected</button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <CoverageGrid cells={coverageCells}/>
        <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.45 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>coverage</div>
          <div style={{ fontFamily: 'JetBrains Mono', fontSize: 16, fontWeight: 500, color: 'var(--text)' }}>{coverage}%</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>capture more<br/>in empty cells</div>
        </div>
      </div>
    </Section>
  );
}

export function SolverButton({ onSolve, busy, label = "Run calibration", status, statusKind }) {
  // statusKind: 'err' | 'warn' | 'ok' | undefined — drives the color of the status line.
  const color =
    statusKind === 'err'  ? 'var(--err)'  :
    statusKind === 'warn' ? 'var(--warn)' :
    statusKind === 'ok'   ? 'var(--ok)'   : 'var(--text-3)';
  return (
    <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)' }}>
      <button className="btn primary block lg" onClick={onSolve} disabled={busy}>
        {busy ? '◉ solving…' : '▶ ' + label}
      </button>
      {status ? (
        <div className="mono" style={{ marginTop: 6, fontSize: 11, color, lineHeight: 1.35, wordBreak: 'break-word' }}>
          {status}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'JetBrains Mono' }}>
          <span>⌘↵ run</span><span>⌘S export YAML</span>
        </div>
      )}
    </div>
  );
}

export function SolverPanel({ iters = 28, cost = 0.184, cond = 142.3, algo = "Levenberg-Marquardt" }) {
  return (
    <Section title="Solver" hint={algo}>
      <KV items={[
        ['iterations', iters, ''],
        ['final cost', cost.toFixed(4), ''],
        ['condition κ', cond.toFixed(1), cond > 1000 ? 'warn' : ''],
        ['converged', '✓ yes', 'pos'],
        ['termination', 'Δcost < 1e-6', ''],
      ]}/>
    </Section>
  );
}

export function SourcePanel({ live, onLive, device, onDevice, bagPath, onBagPath, streamInfo }) {
  const hasInfo = streamInfo && streamInfo.open && streamInfo.width;
  const resLabel = hasInfo
    ? `${streamInfo.width} × ${streamInfo.height} @ ${streamInfo.capture_fps?.toFixed(1) ?? '—'} / ${streamInfo.fps_advertised?.toFixed(0) ?? '—'} fps`
    : 'no live device';
  return (
    <Section title="Source" hint={live ? 'live' : 'recorded'} right={
      <Seg value={live ? 'live' : 'bag'} onChange={v => onLive(v === 'live')} options={[{value:'live', label:'live'},{value:'bag',label:'bag'}]}/>
    }>
      {live ? (
        <>
          <Field label="device">
            <select className="select" value={device} onChange={e => onDevice(e.target.value)}>
              <option>/dev/video0 · Basler acA1920</option>
              <option>/dev/video2 · RealSense D435</option>
              <option>/camera/image_raw · ROS2</option>
              <option>zed_left · ZED 2i</option>
            </select>
          </Field>
          <Field label="resolution">
            <div className="input mono" style={{ display:'flex', alignItems:'center', color: hasInfo ? 'var(--text-1)' : 'var(--text-4)', fontSize: 11.5 }}>
              {resLabel}
            </div>
          </Field>
          <Field label="exposure">
            <div style={{ display:'flex', gap: 4, alignItems:'center', width: '100%' }}>
              <input type="range" min="0" max="100" defaultValue="42" style={{ flex: 1 }}/>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', minWidth: 36, textAlign: 'right' }}>8.3 ms</span>
            </div>
          </Field>
        </>
      ) : (
        <>
          <Field label="bag file">
            <input className="input" value={bagPath} onChange={e => onBagPath(e.target.value)}/>
          </Field>
          <Field label="topic">
            <select className="select"><option>/camera/image_raw</option><option>/cam0/image</option></select>
          </Field>
          <Field label="range">
            <div className="pair">
              <input className="input num mono" defaultValue="0.00"/>
              <input className="input num mono" defaultValue="42.30"/>
            </div>
          </Field>
        </>
      )}
    </Section>
  );
}

export function TargetPanel({ board, onBoard }) {
  return (
    <Section title="Calibration target">
      <Field label="type">
        <Seg value={board.type} onChange={v => onBoard({...board, type: v})} full
             options={[{value:'chess', label:'chess'}, {value:'charuco', label:'charuco'}]}/>
      </Field>
      <Field label="cols × rows">
        <div className="pair">
          <input className="input num" type="number" value={board.cols} onChange={e => onBoard({...board, cols: +e.target.value})}/>
          <input className="input num" type="number" value={board.rows} onChange={e => onBoard({...board, rows: +e.target.value})}/>
        </div>
      </Field>
      <Field label="square">
        <NumInput value={board.sq} step={0.001} onChange={v => onBoard({...board, sq: v})} suffix="m"/>
      </Field>
      {board.type === 'charuco' && (
        <Field label="marker">
          <NumInput value={board.marker || 0.018} step={0.001} onChange={v => onBoard({...board, marker: v})} suffix="m"/>
        </Field>
      )}
      <Field label="dict">
        <select className="select"><option>DICT_4X4_50</option><option>DICT_5X5_100</option><option>DICT_6X6_250</option></select>
      </Field>
    </Section>
  );
}

export function LogStrip({ lines }) {
  return (
    <div className="footer">
      <span><b>ready</b></span>
      <span className="sep">│</span>
      <span>{lines[0]}</span>
      <span className="sep">│</span>
      <span style={{ flex: 1, color: 'var(--text-4)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{lines[1]}</span>
      <span className="sep">│</span>
      <span>cam <b>30.1 fps</b></span>
      <span className="sep">│</span>
      <span>tracker <b>240 Hz</b></span>
      <span className="sep">│</span>
      <span>mem <b>284 MB</b></span>
    </div>
  );
}
