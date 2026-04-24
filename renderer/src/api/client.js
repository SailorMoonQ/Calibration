let cached = null;

async function info() {
  if (cached) return cached;
  if (typeof window !== 'undefined' && window.calib) {
    cached = await window.calib.getBackend();
  }
  if (!cached) cached = { baseUrl: 'http://127.0.0.1:8765', port: 8765 };
  return cached;
}

async function request(path, opts = {}) {
  const { baseUrl } = await info();
  const res = await fetch(baseUrl + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return res.json();
}

export const api = {
  health: () => request('/health'),
  listSources: () => request('/sources'),
  listStreamDevices: () => request('/stream/devices'),
  streamInfo: (device) => request(`/stream/info?device=${encodeURIComponent(device)}`),
  snap: (device, dir) => request('/stream/snap', { method: 'POST', body: JSON.stringify({ device, dir }) }),
  snapPair: (device0, device1, dir0, dir1) => request('/stream/snap_pair', {
    method: 'POST',
    body: JSON.stringify({ device0, device1, dir0, dir1 }),
  }),
  calibrate: (type, body) => request(`/calibrate/${type}`, { method: 'POST', body: JSON.stringify(body) }),
  detect: (body) => request('/detect', { method: 'POST', body: JSON.stringify(body) }),
  detectFile: (body) => request('/detect/file', { method: 'POST', body: JSON.stringify(body) }),
  listDataset: (path) => request(`/dataset/list?path=${encodeURIComponent(path)}`),
  saveCalibration: (body) => request('/calibration/save', { method: 'POST', body: JSON.stringify(body) }),
  loadCalibration: (path) => request('/calibration/load', { method: 'POST', body: JSON.stringify({ path }) }),
};

export async function mjpegUrl(device, opts = {}) {
  const { baseUrl } = await info();
  const qs = new URLSearchParams({
    device,
    fps: String(opts.fps ?? 15),
    quality: String(opts.quality ?? 80),
    t: String(Date.now()), // cache-bust so re-subscribing re-opens
  });
  return `${baseUrl}/stream/mjpeg?${qs.toString()}`;
}

export async function posesWsUrl(opts = {}) {
  const { port } = await info();
  const list = Array.isArray(opts.sources) && opts.sources.length
    ? opts.sources
    : [opts.source ?? 'mock'];
  const qs = new URLSearchParams({
    fps: String(opts.fps ?? 30),
    sources: list.join(','),
  });
  if (opts.ip) qs.set('ip', opts.ip);
  return `ws://127.0.0.1:${port}/poses/stream?${qs.toString()}`;
}

export async function streamWsUrl(device, opts = {}) {
  const { port } = await info();
  const qs = new URLSearchParams({
    device,
    fps: String(opts.fps ?? 10),
    quality: String(opts.quality ?? 70),
    detect: opts.detect ? '1' : '0',
  });
  if (opts.board) {
    qs.set('board_type', opts.board.type);
    qs.set('cols', String(opts.board.cols));
    qs.set('rows', String(opts.board.rows));
    qs.set('square', String(opts.board.sq));
    if (opts.board.marker != null) qs.set('marker', String(opts.board.marker));
    if (opts.board.dictionary) qs.set('dictionary', opts.board.dictionary);
  }
  return `ws://127.0.0.1:${port}/stream/ws?${qs.toString()}`;
}

export async function frameUrl(path) {
  const { baseUrl } = await info();
  return `${baseUrl}/dataset/frame?path=${encodeURIComponent(path)}`;
}

export async function fetchRectifiedBlob({ path, K, D, balance = 0.5, fov_scale = 1.0 }) {
  const { baseUrl } = await info();
  const res = await fetch(`${baseUrl}/dataset/rectified`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, K, D, balance, fov_scale }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`rectify ${res.status}: ${txt}`);
  }
  return res.blob();
}

export async function pickFolder(defaultPath) {
  if (typeof window !== 'undefined' && window.calib && window.calib.pickFolder) {
    return window.calib.pickFolder(defaultPath);
  }
  return null;
}

export async function pickSaveFile(opts) {
  if (typeof window !== 'undefined' && window.calib && window.calib.pickSaveFile) {
    return window.calib.pickSaveFile(opts);
  }
  return null;
}

export async function pickOpenFile(opts) {
  if (typeof window !== 'undefined' && window.calib && window.calib.pickOpenFile) {
    return window.calib.pickOpenFile(opts);
  }
  return null;
}

export async function openStream(onMessage) {
  const { port } = await info();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
  ws.addEventListener('message', (ev) => {
    try { onMessage(JSON.parse(ev.data)); }
    catch { onMessage(ev.data); }
  });
  return ws;
}
