import React, { useRef, useState } from 'react';
import { project, applyT } from '../lib/math3d.js';

export function Axes3D({ T = null, cam, len = 0.08, label, thick = 2 }) {
  const o = T ? applyT(T, [0,0,0]) : [0,0,0];
  const x = T ? applyT(T, [len,0,0]) : [len,0,0];
  const y = T ? applyT(T, [0,len,0]) : [0,len,0];
  const z = T ? applyT(T, [0,0,len]) : [0,0,len];
  const po = project(o, cam);
  const px = project(x, cam);
  const py = project(y, cam);
  const pz = project(z, cam);
  return (
    <g>
      <line x1={po.x} y1={po.y} x2={px.x} y2={px.y} stroke="var(--axis-x)" strokeWidth={thick}/>
      <line x1={po.x} y1={po.y} x2={py.x} y2={py.y} stroke="var(--axis-y)" strokeWidth={thick}/>
      <line x1={po.x} y1={po.y} x2={pz.x} y2={pz.y} stroke="var(--axis-z)" strokeWidth={thick}/>
      <circle cx={po.x} cy={po.y} r="2" fill="#fff"/>
      {label && <text x={po.x + 6} y={po.y - 6} fontSize="10" fill="var(--view-text)" fontFamily="JetBrains Mono">{label}</text>}
    </g>
  );
}

export function Frustum3D({ T, cam, fov = 0.6, aspect = 1.33, near = 0.03, far = 0.18, color = "var(--accent-2)", label }) {
  const h = Math.tan(fov/2) * far;
  const wN = h * aspect * (near/far);
  const hN = h * (near/far);
  const w = h * aspect;
  const pts = {
    o: applyT(T, [0,0,0]),
    nTL: applyT(T, [-wN, hN, near]), nTR: applyT(T, [wN, hN, near]),
    nBR: applyT(T, [wN, -hN, near]), nBL: applyT(T, [-wN, -hN, near]),
    fTL: applyT(T, [-w, h, far]), fTR: applyT(T, [w, h, far]),
    fBR: applyT(T, [w, -h, far]), fBL: applyT(T, [-w, -h, far]),
  };
  const P = Object.fromEntries(Object.entries(pts).map(([k, v]) => [k, project(v, cam)]));
  const L = (a, b) => <line x1={P[a].x} y1={P[a].y} x2={P[b].x} y2={P[b].y} stroke={color} strokeWidth="1.2"/>;
  return (
    <g opacity="0.95">
      {L('o','fTL')}{L('o','fTR')}{L('o','fBR')}{L('o','fBL')}
      {L('fTL','fTR')}{L('fTR','fBR')}{L('fBR','fBL')}{L('fBL','fTL')}
      {L('nTL','nTR')}{L('nTR','nBR')}{L('nBR','nBL')}{L('nBL','nTL')}
      <polygon points={`${P.fTL.x},${P.fTL.y} ${P.fTR.x},${P.fTR.y} ${P.fBR.x},${P.fBR.y} ${P.fBL.x},${P.fBL.y}`} fill={color} opacity="0.06"/>
      {label && <text x={P.o.x - 6} y={P.o.y - 8} fontSize="10" fill={color} fontFamily="JetBrains Mono">{label}</text>}
    </g>
  );
}

export function Ground3D({ cam, size = 0.4, step = 0.04, z = -0.12 }) {
  const lines = [];
  const n = Math.round(size / step);
  for (let i = -n; i <= n; i++) {
    const a = project([i*step, z, -size], cam);
    const b = project([i*step, z,  size], cam);
    const c = project([-size, z, i*step], cam);
    const d = project([ size, z, i*step], cam);
    const op = i === 0 ? 0.45 : 0.18;
    lines.push(<line key={'vx'+i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(140,170,210,1)" strokeOpacity={op} strokeWidth="1"/>);
    lines.push(<line key={'vz'+i} x1={c.x} y1={c.y} x2={d.x} y2={d.y} stroke="rgba(140,170,210,1)" strokeOpacity={op} strokeWidth="1"/>);
  }
  return <g>{lines}</g>;
}

export function Traj3D({ points, cam, color = "var(--accent-2)", dotEvery = 5 }) {
  const proj = points.map(p => project(p, cam));
  const d = proj.map((p, i) => (i?'L':'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth="1.25" opacity="0.9"/>
      {proj.map((p, i) => i % dotEvery === 0 && <circle key={i} cx={p.x} cy={p.y} r="1.2" fill={color} opacity="0.85"/>)}
    </g>
  );
}

export function Chessboard3D({ T, cam, cols = 9, rows = 6, sq = 0.025 }) {
  const tiles = [];
  const w = cols * sq, h = rows * sq;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x0 = -w/2 + i*sq, y0 = -h/2 + j*sq;
      const p00 = project(applyT(T, [x0, y0, 0]), cam);
      const p10 = project(applyT(T, [x0+sq, y0, 0]), cam);
      const p11 = project(applyT(T, [x0+sq, y0+sq, 0]), cam);
      const p01 = project(applyT(T, [x0, y0+sq, 0]), cam);
      const dark = (i + j) % 2 === 0;
      tiles.push(<polygon key={i+'-'+j} points={`${p00.x},${p00.y} ${p10.x},${p10.y} ${p11.x},${p11.y} ${p01.x},${p01.y}`} fill={dark ? '#1a2029' : '#c5cdd6'} stroke="#2c333c" strokeWidth="0.3"/>);
    }
  }
  return <g>{tiles}<Axes3D T={T} cam={cam} len={0.05} label="board"/></g>;
}

export function Gripper3D({ T, cam, opening = 0.035, len = 0.06, color = "#e5d890" }) {
  const w = opening/2, h = 0.012, l = len;
  const box = [
    [-h, -h, -l*0.6], [h, -h, -l*0.6], [h, h, -l*0.6], [-h, h, -l*0.6],
    [-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0],
  ];
  const P = box.map(p => project(applyT(T, p), cam));
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const jaw = (sign) => {
    const pts = [
      [sign*w - h*0.3, -h, 0],  [sign*w + h*0.3, -h, 0],
      [sign*w + h*0.3,  h, 0],  [sign*w - h*0.3,  h, 0],
      [sign*w - h*0.3, -h, l],  [sign*w + h*0.3, -h, l],
      [sign*w + h*0.3,  h, l],  [sign*w - h*0.3,  h, l],
    ];
    return pts.map(p => project(applyT(T, p), cam));
  };
  const jL = jaw(-1), jR = jaw(1);
  const drawBox = (pp, c) => edges.map(([a,b], i) => <line key={c+i} x1={pp[a].x} y1={pp[a].y} x2={pp[b].x} y2={pp[b].y} stroke={color} strokeWidth="1.1"/>);
  return (
    <g>
      {drawBox(P, 'b')}
      {drawBox(jL, 'l')}
      {drawBox(jR, 'r')}
      <Axes3D T={T} cam={cam} len={0.04} label="gripper" thick={1.5}/>
    </g>
  );
}

export function HMD3D({ T, cam, color = "#6fbcff" }) {
  const w = 0.09, h = 0.045, d = 0.05;
  const pts = [
    [-w,-h,-d],[w,-h,-d],[w,h,-d],[-w,h,-d],
    [-w,-h, d],[w,-h, d],[w,h, d],[-w,h, d],
  ];
  const P = pts.map(p => project(applyT(T, p), cam));
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const lensL = project(applyT(T, [-w*0.45, 0, d]), cam);
  const lensR = project(applyT(T, [w*0.45, 0, d]), cam);
  return (
    <g>
      {edges.map(([a,b], i) => <line key={i} x1={P[a].x} y1={P[a].y} x2={P[b].x} y2={P[b].y} stroke={color} strokeWidth="1.1"/>)}
      <circle cx={lensL.x} cy={lensL.y} r="6" fill="none" stroke={color} strokeWidth="1"/>
      <circle cx={lensR.x} cy={lensR.y} r="6" fill="none" stroke={color} strokeWidth="1"/>
      <Axes3D T={T} cam={cam} len={0.04} label="hmd" thick={1.5}/>
    </g>
  );
}

export function Controller3D({ T, cam, color = "#b78cff", label = "ctrl" }) {
  const pts = [
    [-0.015,-0.015,-0.035],[0.015,-0.015,-0.035],[0.015,0.015,-0.035],[-0.015,0.015,-0.035],
    [-0.015,-0.015, 0.025],[0.015,-0.015, 0.025],[0.015,0.015, 0.025],[-0.015,0.015, 0.025],
    [-0.03,0.03, 0.04],[0.03,0.03, 0.04],[0.03,0.03, 0.06],[-0.03,0.03, 0.06],
  ];
  const P = pts.map(p => project(applyT(T, p), cam));
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7],[8,9],[9,10],[10,11],[11,8]];
  return (
    <g>
      {edges.map(([a,b], i) => <line key={i} x1={P[a].x} y1={P[a].y} x2={P[b].x} y2={P[b].y} stroke={color} strokeWidth="1.1"/>)}
      <Axes3D T={T} cam={cam} len={0.04} label={label} thick={1.5}/>
    </g>
  );
}

export function Tracker3D({ T, cam, color = "#ffa95a", label = "tracker" }) {
  const r = 0.025;
  const pts = [
    [-r,-r*0.3,-r],[r,-r*0.3,-r],[r,r*0.3,-r],[-r,r*0.3,-r],
    [-r,-r*0.3, r],[r,-r*0.3, r],[r,r*0.3, r],[-r,r*0.3, r],
  ];
  const P = pts.map(p => project(applyT(T, p), cam));
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  return (
    <g>
      {edges.map(([a,b], i) => <line key={i} x1={P[a].x} y1={P[a].y} x2={P[b].x} y2={P[b].y} stroke={color} strokeWidth="1.1"/>)}
      <circle cx={project(applyT(T, [0,0,0]), cam).x} cy={project(applyT(T, [0,0,0]), cam).y} r="2" fill={color}/>
      <Axes3D T={T} cam={cam} len={0.04} label={label} thick={1.5}/>
    </g>
  );
}

export function RigidLink3D({ a, b, cam, color = "#8a97aa" }) {
  const pa = project(a, cam), pb = project(b, cam);
  return (
    <g>
      <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={color} strokeWidth="1" strokeDasharray="3 3"/>
      <text x={(pa.x + pb.x)/2 + 4} y={(pa.y + pb.y)/2 - 4} fontSize="9" fill={color} fontFamily="JetBrains Mono">rigid</text>
    </g>
  );
}

export function Scene3D({ w, h, children, defaultYaw = 0.6, defaultPitch = 0.35 }) {
  const [yaw, setYaw] = useState(defaultYaw);
  const [pitch, setPitch] = useState(defaultPitch);
  const [scale, setScale] = useState(Math.min(w, h) * 1.5);
  const draggingRef = useRef(null);

  const onDown = (e) => { draggingRef.current = { x: e.clientX, y: e.clientY, yaw, pitch }; };
  const onMove = (e) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - draggingRef.current.x;
    const dy = e.clientY - draggingRef.current.y;
    setYaw(draggingRef.current.yaw + dx * 0.008);
    setPitch(Math.max(-1.2, Math.min(1.2, draggingRef.current.pitch + dy * 0.008)));
  };
  const onUp = () => { draggingRef.current = null; };
  const onWheel = (e) => {
    e.preventDefault();
    setScale(s => Math.max(60, Math.min(s * (e.deltaY > 0 ? 0.92 : 1.08), 3000)));
  };

  const cam = { yaw, pitch, scale, ox: w/2, oy: h/2 };

  return (
    <svg className="fill" viewBox={`0 0 ${w} ${h}`}
         onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}
         style={{ cursor: draggingRef.current ? 'grabbing' : 'grab' }}>
      <defs>
        <radialGradient id="s3d-bg" cx="50%" cy="40%" r="80%">
          <stop offset="0" stopColor="#161c26"/>
          <stop offset="1" stopColor="#0a0d12"/>
        </radialGradient>
      </defs>
      <rect width={w} height={h} fill="url(#s3d-bg)"/>
      <Ground3D cam={cam}/>
      <Axes3D cam={cam} len={0.06} label="world"/>
      {typeof children === 'function' ? children(cam) : children}
      <text x={10} y={h - 10} fontSize="10" fontFamily="JetBrains Mono" fill="var(--view-text-2)">yaw {(yaw*180/Math.PI).toFixed(0)}° pitch {(pitch*180/Math.PI).toFixed(0)}° · drag to orbit · scroll to zoom</text>
    </svg>
  );
}
