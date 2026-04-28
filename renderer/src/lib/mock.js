export function genFrames(n, baseErr = 0.28) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    err: Math.max(0.05, baseErr + Math.sin(i * 0.9) * 0.18 + (Math.random() - 0.5) * 0.12),
    tx: Math.sin(i * 0.7) * 6,
    ty: Math.cos(i * 0.5) * 3,
    rot: Math.sin(i * 0.3),
  }));
}

export function genResiduals(cols = 8, rows = 5, cx = 500, cy = 300, peak = 0.4) {
  const out = [];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const x = 80 + i * 60, y = 60 + j * 50;
    const nx = (x - cx) / cx, ny = (y - cy) / cy;
    const d = Math.hypot(nx, ny);
    const mag = 0.1 + d * peak + (Math.random() - 0.5) * 0.1;
    const ang = Math.atan2(ny, nx) + Math.PI;
    out.push({ x, y, ex: Math.cos(ang) * mag, ey: Math.sin(ang) * mag });
  }
  return out;
}

export function gridCells(n, fill) {
  const arr = Array(n).fill(false);
  fill.forEach(i => { arr[i] = true; });
  return arr;
}
