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

// Per-device cache for /stream/info. The corner-readout in <LivePreview/> and
// the side panel in IntrinsicsTab/FisheyeTab both poll this endpoint, and the
// two pollers tend to align in phase since they spin up when the same tab
// mounts — that landed two HTTP calls within milliseconds of each other every
// 2 s, each going through source_manager.get/release with a wait_frame inside.
// Cache hits within TTL just return the previous value; concurrent callers
// share the in-flight promise. TTL is below the 2 s poll cadence so each
// polling cycle still triggers exactly one fresh fetch — tabs that don't run
// their own poll (Extrinsics, HandEye) keep working unchanged.
const _streamInfoCache = new Map();
const _streamInfoGen = new Map();
const STREAM_INFO_TTL_MS = 1500;

function streamInfoCached(device) {
  const now = Date.now();
  const entry = _streamInfoCache.get(device);
  if (entry) {
    if (entry.value && (now - entry.ts) < STREAM_INFO_TTL_MS) {
      return Promise.resolve(entry.value);
    }
    if (entry.inflight) return entry.inflight;
  }
  // Generation guard: a response that raced an invalidation carries pre-change
  // state — writing it back would re-seed the cache with stale info and a
  // fresh ts. Only the generation it was requested under may populate.
  const gen = _streamInfoGen.get(device) ?? 0;
  const fresh = () => (_streamInfoGen.get(device) ?? 0) === gen;
  const inflight = request(`/stream/info?device=${encodeURIComponent(device)}`)
    .then(value => {
      if (fresh()) _streamInfoCache.set(device, { ts: Date.now(), value, inflight: null });
      return value;
    })
    .catch(err => {
      // Don't poison the cache with a stale failure — next caller retries.
      if (fresh()) _streamInfoCache.set(device, { ts: 0, value: null, inflight: null });
      throw err;
    });
  _streamInfoCache.set(device, {
    ts: entry?.ts ?? 0,
    value: entry?.value ?? null,
    inflight,
  });
  return inflight;
}

// State-changing endpoints invalidate the cache so the next /stream/info hits
// the backend instead of returning the pre-change snapshot. Bumping the
// generation also disowns any in-flight request started before the change.
function invalidateStreamInfo(device) {
  _streamInfoGen.set(device, (_streamInfoGen.get(device) ?? 0) + 1);
  _streamInfoCache.delete(device);
}

export const api = {
  health: () => request('/health'),
  listSources: () => request('/sources'),
  listStreamDevices: () => request('/stream/devices'),
  listRos2Topics: () => request('/stream/ros2_topics'),
  streamInfo: streamInfoCached,
  setStreamResolution: (device, width, height) => {
    invalidateStreamInfo(device);
    return request('/stream/resolution', {
      method: 'POST',
      body: JSON.stringify({ device, width, height }),
    });
  },
  listStreamResolutions: (device) =>
    request(`/stream/resolutions?device=${encodeURIComponent(device)}`),
  setStreamClip: (device, width, height) => {
    invalidateStreamInfo(device);
    return request('/stream/clip', {
      method: 'POST',
      body: JSON.stringify({ device, width, height }),
    });
  },
  snap: (device, dir) => request('/stream/snap', { method: 'POST', body: JSON.stringify({ device, dir }) }),
  appendHandeyePose: ({ poses_path, basename, T, ts, meta }) =>
    request('/handeye/append_pose', {
      method: 'POST',
      body: JSON.stringify({ poses_path, basename, T, ts, meta }),
    }),
  snapPair: (device0, device1, dir0, dir1) => request('/stream/snap_pair', {
    method: 'POST',
    body: JSON.stringify({ device0, device1, dir0, dir1 }),
  }),
  calibrate: (type, body) => request(`/calibrate/${type}`, { method: 'POST', body: JSON.stringify(body) }),
  detect: (body) => request('/detect', { method: 'POST', body: JSON.stringify(body) }),
  detectFile: (body) => request('/detect/file', { method: 'POST', body: JSON.stringify(body) }),
  listDataset: (path) => request(`/dataset/list?path=${encodeURIComponent(path)}`),
  deleteFrame: (path) => request('/dataset/delete', { method: 'POST', body: JSON.stringify({ path }) }),
  clearDataset: (path) => request('/dataset/clear', { method: 'POST', body: JSON.stringify({ path }) }),
  restoreFrame: (trash_path, original_path) => request('/dataset/restore', {
    method: 'POST', body: JSON.stringify({ trash_path, original_path }),
  }),
  saveCalibration: (body) => request('/calibration/save', { method: 'POST', body: JSON.stringify(body) }),
  exportCameraIntrix: (body) => request('/calibration/export_camera_intrix', { method: 'POST', body: JSON.stringify(body) }),
  loadCalibration: (path) => request('/calibration/load', { method: 'POST', body: JSON.stringify({ path }) }),
};

export const recording = {
  save: ({ kind, samples, path, session, name, unique }) =>
    request('/recording/save', {
      method: 'POST',
      body: JSON.stringify({ kind, samples, path, session, name, unique }),
    }),
  listTopics: (mcap_path) =>
    request(`/recording/list_topics?mcap_path=${encodeURIComponent(mcap_path)}`),
  importMcap: ({ mcap_path, topic, out_path }) =>
    request('/recording/import_mcap', { method: 'POST', body: JSON.stringify({ mcap_path, topic, out_path }) }),
  importFile: ({ path, format }) =>
    request('/recording/import_file', { method: 'POST', body: JSON.stringify({ path, format }) }),
  estimateSync: ({ a_path, b_path, max_skew_s }) =>
    request('/recording/sync/estimate', { method: 'POST', body: JSON.stringify({ a_path, b_path, max_skew_s }) }),
  sync: ({ a_path, b_path, out_path, max_skew_s, max_pair_gap_s, delta_t_override }) =>
    request('/recording/sync', { method: 'POST', body: JSON.stringify({ a_path, b_path, out_path, max_skew_s, max_pair_gap_s, delta_t_override }) }),
  calibrateHandeyePose: ({ synced_path, method, pattern }) =>
    request('/calibrate/handeye_pose', { method: 'POST', body: JSON.stringify({ synced_path, method, pattern }) }),
  calibrateHandeyePoseAll: ({ synced_path, pattern }) =>
    request('/calibrate/handeye_pose_all', { method: 'POST', body: JSON.stringify({ synced_path, pattern }) }),
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

// Live-undistorted MJPEG. `model='fisheye'` (default, K/D = 3x3 + [k1..k4],
// balance + fov_scale) or `model='pinhole'` (K/D = 3x3 + Brown-Conrady up to
// 8 elements, alpha). Cache-bust `t` ensures intrinsics changes reopen the stream.
export async function rectifiedMjpegUrl(device, {
  K, D,
  model = 'fisheye',
  balance = 0.5, fov_scale = 1.0,
  alpha = 0.5,
  method = 'remap', fps = 15, quality = 80,
} = {}) {
  const { baseUrl } = await info();
  const qs = new URLSearchParams({
    device,
    fx: String(K[0][0]), fy: String(K[1][1]), cx: String(K[0][2]), cy: String(K[1][2]),
    model, method,
    fps: String(fps), quality: String(quality),
    t: String(Date.now()),
  });
  if (model === 'fisheye') {
    qs.set('k1', String(D[0] ?? 0));
    qs.set('k2', String(D[1] ?? 0));
    qs.set('k3', String(D[2] ?? 0));
    qs.set('k4', String(D[3] ?? 0));
    qs.set('balance', String(balance));
    qs.set('fov_scale', String(fov_scale));
  } else {
    // Brown-Conrady: D = [k1, k2, p1, p2, k3, k4, k5, k6] (last four optional, default 0).
    qs.set('k1', String(D[0] ?? 0));
    qs.set('k2', String(D[1] ?? 0));
    qs.set('p1', String(D[2] ?? 0));
    qs.set('p2', String(D[3] ?? 0));
    qs.set('k3', String(D[4] ?? 0));
    qs.set('k4', String(D[5] ?? 0));
    qs.set('k5', String(D[6] ?? 0));
    qs.set('k6', String(D[7] ?? 0));
    qs.set('alpha', String(alpha));
  }
  return `${baseUrl}/stream/mjpeg_rect?${qs.toString()}`;
}

export async function posesWsUrl(opts = {}) {
  const { port } = await info();
  const list = Array.isArray(opts.sources) && opts.sources.length
    ? opts.sources
    : [opts.source ?? 'steamvr'];
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

export async function fetchRectifiedBlob({
  path, K, D,
  model = 'fisheye',
  balance = 0.5, fov_scale = 1.0,
  alpha = 0.5,
  method = 'remap',
}) {
  const { baseUrl } = await info();
  const body = { path, K, D, model, method };
  if (model === 'fisheye') {
    body.balance = balance;
    body.fov_scale = fov_scale;
  } else {
    body.alpha = alpha;
  }
  const res = await fetch(`${baseUrl}/dataset/rectified`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

export async function openPath(p) {
  if (typeof window !== 'undefined' && window.calib && window.calib.openPath) {
    return window.calib.openPath(p);
  }
  return 'no IPC bridge';
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
