import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Section, Seg, Chk, Field, Matrix, KV } from '../components/primitives.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { LiveDetectedFrame } from '../components/LiveDetectedFrame.jsx';
import { Ros2TopicPicker } from '../components/Ros2TopicPicker.jsx';
import { useCameraSource, CameraSourcePanel } from '../components/CameraSource.jsx';
import {
  Scene3D, Frustum3D, HMD3D, Controller3D, Chessboard3D, RigidLink3D,
} from '../components/scene3d.jsx';
import {
  FrameStrip, ErrorPanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
  trafficKindForRms, trafficColor,
} from '../components/panels.jsx';
import { makeT, applyT, composeT } from '../lib/math3d.js';
import { DEFAULT_BOARD } from '../lib/board.js';
import { computeCoverage, cellIndexFor } from '../lib/coverage.js';
import { api, pickFolder, pickSaveFile, pickOpenFile, openPath, posesWsUrl } from '../api/client.js';
import { speak } from '../lib/voice.js';

const UNDO_LIMIT = 20;
const basename = (p) => (p || '').split('/').pop();
const CAMERA_INTRIX_PATH = '/mibot_env/configs/camera_intrix.yaml';
const CAMERA_SLOT_RE = /(?:^|\/)(head|left|right|back)(?:\/|$)/;

function cameraSlotFromSource(...sources) {
  for (const s of sources) {
    const m = CAMERA_SLOT_RE.exec(s || '');
    if (m) return m[1];
  }
  return null;
}

const TRACKER_SOURCES = [
  { value: 'arx',     label: 'ARX 双臂' },
  { value: 'oculus',  label: 'Oculus Reader' },
  { value: 'pico',    label: 'PICO' },
  { value: 'ros2',    label: 'ROS2 topic' },
  { value: 'steamvr', label: 'SteamVR' },
  { value: 'file',    label: 'JSON file' },
];

export function HandEyeTab({ solvePattern, setSolvePattern, tweaks }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState('hmd');
  const isHMD = kind === 'hmd';
  const trackerLabel = isHMD ? t('handeye.trackerHmd') : t('handeye.trackerController');
  const xmatLabel = isHMD ? 'T_hmd_cam' : 'T_ctrl_cam';
  const TrackerGlyph = isHMD ? HMD3D : Controller3D;

  const [board, setBoard] = useState(DEFAULT_BOARD);
  const [method, setMethod] = useState('park');
  const [showBoard, setShowBoard] = useState(true);

  const [trackerSource, setTrackerSource] = useState('file');
  const [oculusDevice, setOculusDevice] = useState('');
  const [picoDevice, setPicoDevice] = useState('');
  const [arxDevice, setArxDevice] = useState('arx_ee_r');
  const [trackerRos2Topic, setTrackerRos2Topic] = useState('');
  const [steamvrSerial, setSteamvrSerial] = useState('');

  const [datasetPath, setDatasetPath] = useState('');
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [posesPath, setPosesPath] = useState('');
  const [camInt, setCamInt] = useState(null); // { K, D, path, distortion_model }

  const [viewMode, setViewMode] = useState('live');

  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // status carries a message plus an explicit error flag so the solver-status
  // colour is language-independent (no regex-matching the localized text).
  const [status, setStatusMsg] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const setStatus = (msg, isErr = false) => { setStatusMsg(msg); setStatusErr(isErr); };

  // Spoken cues (Edge-TTS clips, Chinese), reused from the fisheye capture loop.
  // Gated by the ⚙ settings; failures surface in the status bar de-duped so a
  // persistent autoplay block doesn't overwrite it on every cue.
  const voicePrompts = !!tweaks?.voicePrompts;
  const lastSpokeRef = useRef({});
  const voiceErrRef = useRef('');
  const say = useCallback((name, minGapMs = 0) => {
    if (!voicePrompts) return;
    const now = Date.now();
    if (minGapMs && now - (lastSpokeRef.current[name] || 0) < minGapMs) return;
    lastSpokeRef.current[name] = now;
    speak(name).catch((e) => {
      if (e?.name === 'AbortError') return;  // a newer cue cut this one off — expected
      const msg = e?.message || e?.name || 'play blocked';
      if (msg === voiceErrRef.current) return;
      voiceErrRef.current = msg;
      setStatus(t('fisheye.voicePlayFailed', { name, error: msg }), true);
    });
  }, [voicePrompts, t]);

  // Live tracker stream (used to attach pose to each captured image).
  const [connected, setConnected] = useState(false);
  const [poseHz, setPoseHz] = useState(0);
  const [poseStaleMs, setPoseStaleMs] = useState(null);
  const [livePoseT, setLivePoseT] = useState(null);  // 4x4 reflected for the 3D scene
  const wsRef = useRef(null);
  const latestPoseRef = useRef(null);  // {ts, T, device}
  const poseTickWindowRef = useRef([]); // last ~1s of wall_ts for fps calc

  const trackerDeviceKey = () => {
    if (trackerSource === 'arx')     return arxDevice || 'arx_ee_r';
    if (trackerSource === 'oculus')  return oculusDevice || (kind === 'ctrl' ? 'controller_R' : 'hmd');
    if (trackerSource === 'pico')    return picoDevice || (kind === 'ctrl' ? 'pico_ctrl_r' : 'pico_hmd');
    if (trackerSource === 'steamvr') return steamvrSerial || (kind === 'ctrl' ? 'controller_R' : 'tracker_0');
    return null;
  };

  const onConnectTracker = useCallback(async () => {
    if (wsRef.current) return;
    if (trackerSource === 'file' || trackerSource === 'ros2') {
      setStatus(t('handeye.notSupportedLive', { source: trackerSource }));
      return;
    }
    const device = trackerDeviceKey();
    if (!device) { setStatus(t('handeye.pickTrackerDevice')); return; }
    setStatus(t('handeye.connectingTracker'));
    try {
      const url = await posesWsUrl({ fps: 30, sources: [trackerSource] });
      // Re-check after the await: a second click while the URL resolved would
      // otherwise open a second socket and leak the first.
      if (wsRef.current) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); setStatus(t('handeye.wsOpen', { source: trackerSource })); };
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        latestPoseRef.current = null;
        setPoseStaleMs(null);
        setPoseHz(0);
        setLivePoseT(null);
      };
      ws.onerror = () => setStatus(t('handeye.wsError'));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'error') { setStatus(t('handeye.sourceError', { source: m.source, message: m.message })); return; }
        if (m.type !== 'sample' || !m.poses) return;
        const T = m.poses[device];
        if (!T) return;
        const ts = (typeof m.wall_ts === 'number') ? m.wall_ts : (Date.now() / 1000);
        latestPoseRef.current = { ts, T, device };
        const win = poseTickWindowRef.current;
        win.push(ts);
        const cutoff = ts - 1.0;
        while (win.length && win[0] < cutoff) win.shift();
      };
    } catch (e) { setStatus(t('handeye.connectFailed', { error: e.message })); }
  }, [trackerSource, oculusDevice, picoDevice, arxDevice, steamvrSerial, kind]);

  const onDisconnectTracker = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    try { ws.close(); } catch { /* swallow */ }
    wsRef.current = null;
    setConnected(false);
    latestPoseRef.current = null;
    setPoseStaleMs(null);
    setPoseHz(0);
    setLivePoseT(null);
  }, []);

  // Refresh staleness/fps readout twice a second from the ref-held buffer,
  // and reflect the latest pose into React state at 10 Hz so the 3D scene
  // animates smoothly without re-rendering on every WS tick.
  useEffect(() => {
    if (!connected) return;
    const slow = setInterval(() => {
      const lp = latestPoseRef.current;
      if (lp) setPoseStaleMs(Math.max(0, Math.round((Date.now() / 1000 - lp.ts) * 1000)));
      setPoseHz(poseTickWindowRef.current.length);
    }, 500);
    const fast = setInterval(() => {
      const lp = latestPoseRef.current;
      setLivePoseT(lp ? lp.T : null);
    }, 100);
    return () => { clearInterval(slow); clearInterval(fast); };
  }, [connected]);

  // Always disconnect on unmount.
  useEffect(() => () => onDisconnectTracker(), [onDisconnectTracker]);

  const [autoCapture, setAutoCapture] = useState(false);
  const [autoCaptureRate, setAutoCaptureRate] = useState(0.5);  // seconds between snaps
  const [recordedCount, setRecordedCount] = useState(0);

  // Hold the latest onSnap/onDrop/onUndo in refs so the keyboard handler always
  // calls the up-to-date closure without resubscribing on every state tick.
  const onSnapRef = useRef(null);
  const onDropRef = useRef(null);
  const onUndoRef = useRef(null);

  // Undo stack — bounded LIFO, entries: { kind:'snap'|'drop', path, trashPath? }
  const undoStackRef = useRef([]);
  const pushUndo = (entry) => {
    undoStackRef.current = [entry, ...undoStackRef.current].slice(0, UNDO_LIMIT);
  };

  // Keep a ref-shadowed count so the keyboard handler can read it without
  // closing over stale state.
  const datasetCountRef = useRef(0);
  useEffect(() => { datasetCountRef.current = datasetFiles.length; }, [datasetFiles.length]);

  const refreshDataset = async () => {
    if (!datasetPath) return [];
    const r = await api.listDataset(datasetPath);
    setDatasetFiles(r.files);
    return r.files;
  };

  // Coverage tracking. snappedCellsRef holds the grid cells that already
  // contributed a frame this session — auto-capture skips frames whose
  // board centre lands in a claimed cell so the user spreads the rig
  // around the FOV instead of dwelling on one spot. Reset whenever the
  // dataset folder changes (each session starts fresh).
  const snappedCellsRef = useRef(new Set());
  const lastAutoSnapRef = useRef(0);
  const autoSnapInFlightRef = useRef(false);
  useEffect(() => { snappedCellsRef.current = new Set(); }, [datasetPath]);

  const errByPath = useMemo(() => {
    if (!result?.ok) return null;
    const m = new Map();
    (result.detected_paths || []).forEach((name, i) => m.set(name, result.per_frame_err?.[i] ?? 0));
    return m;
  }, [result]);

  const frames = useMemo(() => datasetFiles.map((p, i) => ({
    id: i + 1, err: errByPath?.get(basename(p)) ?? 0, tx: 0, ty: 0, rot: 0,
  })), [datasetFiles, errByPath]);
  const [selected, setSelected] = useState(1);

  const cam = useCameraSource({
    pollEnabled: viewMode === 'live' || datasetFiles.length === 0,
  });
  const { liveDevice } = cam;

  useEffect(() => {
    if (!datasetPath) { setDatasetFiles([]); return; }
    let cancelled = false;
    api.listDataset(datasetPath).then(r => {
      if (cancelled) return;
      setDatasetFiles(r.files);
      setSelected(1);
      setStatus(t('common.images', { count: r.count }));
    }).catch(e => !cancelled && setStatus(t('common.listingFailed', { error: e.message })));
    return () => { cancelled = true; };
  }, [datasetPath]);

  const boardPayload = () => ({
    type: board.type, cols: board.cols, rows: board.rows,
    square: board.sq, marker: board.marker ?? null, dictionary: 'DICT_5X5_100',
  });

  const onPickDataset = async () => {
    const p = await pickFolder(datasetPath || undefined);
    if (p) setDatasetPath(p);
  };

  const onPickPoses = async () => {
    const p = await pickOpenFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (p) { setPosesPath(p); setStatus(t('handeye.posesLoaded', { name: basename(p) })); }
  };

  const onLoadIntrinsics = async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const isCameraIntrix = p === CAMERA_INTRIX_PATH || p.endsWith(CAMERA_INTRIX_PATH);
      const slot = isCameraIntrix ? cameraSlotFromSource(liveDevice, datasetPath) : null;
      const resp = await api.loadCalibration(p, slot ? { slot } : {});
      const d = resp.data || {};
      if (!d.K || !d.D) { setStatus(t('handeye.noKdInYaml', { name: basename(p) })); return; }
      const distortionModel = (d.distortion_model || d.model || 'pinhole').toLowerCase();
      setCamInt({
        K: d.K,
        D: d.D,
        path: p,
        distortion_model: distortionModel.includes('fish') || distortionModel.includes('equidistant') ? 'fisheye' : 'pinhole',
        camera_slot: d.camera_slot || slot || null,
        image_size: d.image_size || null,
      });
      const name = d.camera_slot ? `${basename(p)}:${d.camera_slot}` : basename(p);
      setStatus(t('handeye.intrinsicsLoaded', { name }));
    } catch (e) { setStatus(t('handeye.intrinsicsLoadFailed', { error: e.message })); }
  };

  const onSnap = async () => {
    let dir = datasetPath;
    if (!dir) {
      const picked = await pickFolder();
      if (!picked) { setStatus(t('common.pickSessionFolder')); return; }
      setDatasetPath(picked); dir = picked;
    }
    if (!liveDevice) { setStatus(t('common.pickCamera')); return; }

    // Read pose snapshot BEFORE the snap so time skew is bounded by image-write
    // latency, not the snap RPC round trip. lp may be null (image-only snap).
    const lp = connected ? latestPoseRef.current : null;
    if (connected) {
      if (!lp) { setStatus(t('handeye.noPoseYet')); return; }
      const ageMs = Math.round((Date.now() / 1000 - lp.ts) * 1000);
      if (ageMs > 200) { setStatus(t('handeye.poseStale', { ms: ageMs })); return; }
    }

    let imagePath;
    try {
      const r = await api.snap(liveDevice, dir);
      imagePath = r.path;
    } catch (e) { setStatus(t('common.snapFailed', { error: e.message })); return; }

    const fname = basename(imagePath);

    if (lp) {
      const posesPathLocal = `${dir}/poses.json`;
      const meta = { tracker_source: trackerSource, device: lp.device, kind };
      let appended = false;
      for (let attempt = 0; attempt < 2 && !appended; attempt++) {
        try {
          const r = await api.appendHandeyePose({
            poses_path: posesPathLocal, basename: fname, T: lp.T, ts: lp.ts, meta,
          });
          appended = true;
          setRecordedCount(r.n);
          if (posesPath !== posesPathLocal) setPosesPath(posesPathLocal);
        } catch (e) {
          if (attempt === 1) {
            setStatus(t('handeye.imagePoseAppendFailed', { error: e.message }));
          }
        }
      }
      if (appended) {
        pushUndo({ kind: 'snap', path: imagePath });
        setStatus(t('handeye.snappedPose', { name: fname })); say('captured', 600);
      }
    } else {
      pushUndo({ kind: 'snap', path: imagePath });
      setStatus(t('handeye.snapImageOnly', { name: fname })); say('captured', 600);
    }

    if (dir === datasetPath) {
      const ls = await api.listDataset(datasetPath);
      setDatasetFiles(ls.files);
      setSelected(ls.files.length);
      // Stay in live view so the user keeps seeing the camera feed while
      // recording — switching to 'frame' interrupts the workflow.
    }
  };
  onSnapRef.current = onSnap;

  const onDrop = async () => {
    if (!selectedPath) { setStatus(t('common.noFrameSelected')); return; }
    const name = selectedPath.split('/').pop();
    try {
      const r = await api.deleteFrame(selectedPath);
      pushUndo({ kind: 'drop', path: selectedPath, trashPath: r.trash_path });
      const files = await refreshDataset();
      const newLen = files?.length ?? 0;
      setSelected(Math.min(Math.max(1, selected), Math.max(1, newLen)));
      if (newLen === 0) setViewMode('live');
      setStatus(t('common.dropped', { name }));
    } catch (e) { setStatus(t('common.dropFailed', { error: e.message }), true); }
  };
  onDropRef.current = onDrop;

  const onUndo = async () => {
    const stack = undoStackRef.current;
    if (!stack.length) { setStatus(t('common.nothingToUndo')); return; }
    const entry = stack.pop();
    try {
      if (entry.kind === 'snap') {
        await api.deleteFrame(entry.path);
        const files = await refreshDataset();
        const newLen = files?.length ?? 0;
        setSelected(Math.min(Math.max(1, selected), Math.max(1, newLen)));
        if (newLen === 0) setViewMode('live');
        setStatus(t('common.undidSnap', { name: entry.path.split('/').pop() }));
      } else if (entry.kind === 'drop') {
        await api.restoreFrame(entry.trashPath, entry.path);
        const files = await refreshDataset();
        const idx = files.findIndex(p => p === entry.path);
        if (idx >= 0) { setSelected(idx + 1); setViewMode('frame'); }
        setStatus(t('common.undidDrop', { name: entry.path.split('/').pop() }));
      }
    } catch (e) {
      stack.push(entry);
      setStatus(t('common.undoFailed', { error: e.message }), true);
    }
  };
  onUndoRef.current = onUndo;

  // Keyboard shortcuts: ←/→ frame nav, Space=snap, Ctrl+Z=undo, Del/Bksp=drop.
  // Mirror the FisheyeTab handler exactly so muscle memory transfers.
  useEffect(() => {
    const handler = (e) => {
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSelected(s => Math.max(1, s - 1));
        setViewMode('frame');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSelected(s => Math.min(datasetCountRef.current || 1, s + 1));
        setViewMode('frame');
      } else if (e.key === ' ') {
        e.preventDefault();
        onSnapRef.current?.();
      } else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onUndoRef.current?.();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDropRef.current?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-capture, cell-aware. LiveDetectedFrame fires onMeta on every
  // detected tick; we snap only if (a) auto-capture is on, (b) we're
  // outside the rate-limit window, (c) no snap is already in flight,
  // (d) a tracker pose is fresh (handled inside onSnap), and (e) the
  // board's centroid lands in a coverage cell we haven't claimed yet.
  // This drives the user to fan out across the FOV — same UX the
  // Intrinsics tab already uses.
  const onAutoMeta = useCallback((meta) => {
    if (!autoCapture || !liveDevice || !datasetPath) return;
    const corners = meta?.corners;
    const size = meta?.image_size;
    if (!corners || corners.length < 4 || !size) return;
    const now = performance.now();
    if (now - lastAutoSnapRef.current < autoCaptureRate * 1000) return;
    if (autoSnapInFlightRef.current) return;
    let sx = 0, sy = 0;
    for (const c of corners) { sx += c[0]; sy += c[1]; }
    const cx = sx / corners.length, cy = sy / corners.length;
    const idx = cellIndexFor(cx, cy, size);
    if (idx == null) return;
    if (snappedCellsRef.current.has(idx)) return;
    autoSnapInFlightRef.current = true;
    lastAutoSnapRef.current = now;
    snappedCellsRef.current.add(idx);
    (async () => {
      try { await onSnapRef.current?.(); }
      catch { snappedCellsRef.current.delete(idx); }
      finally { autoSnapInFlightRef.current = false; }
    })();
  }, [autoCapture, autoCaptureRate, liveDevice, datasetPath]);

  const onRun = async () => {
    if (!datasetPath) { setStatus(t('handeye.pickDatasetFolder'), true); say('solveFail'); return; }
    // Any tracker source works for solving — live capture (oculus/pico/steamvr)
    // already writes poses.json next to the images and points posesPath at it,
    // so the solver consumes it exactly like a hand-picked JSON file. The only
    // hard requirement is that some poses.json exists, checked next.
    if (!posesPath) { setStatus(t('handeye.pickPosesJson'), true); say('solveFail'); return; }
    if (!camInt) { setStatus(t('handeye.loadCamIntrinsics'), true); say('solveFail'); return; }
    setBusy(true); setStatus(t('handeye.solvingAxxb')); say('solveStart');
    try {
      const res = await api.calibrate('handeye', {
        method, kind, pattern: solvePattern,
        board: boardPayload(),
        dataset_path: datasetPath,
        poses_path: posesPath,
        K: camInt.K, D: camInt.D,
        distortion_model: camInt.distortion_model,
      });
      setResult(res);
      setStatus(res.ok
        ? t('handeye.rmsResult', { rot: res.rms.toFixed(3), trans: res.final_cost.toFixed(2), message: res.message })
        : t('common.failed', { message: res.message }), !res.ok);
      say(res.ok ? 'solveOk' : 'solveFail');
    } catch (e) { setStatus(t('common.error', { error: e.message }), true); say('solveFail'); } finally { setBusy(false); }
  };

  const onSaveYaml = async () => {
    if (!result?.ok) { setStatus(t('common.nothingToSave')); return; }
    const p = await pickSaveFile({ defaultPath: `handeye_${kind}.yaml` });
    if (!p) return;
    try {
      await api.saveCalibration({
        path: p, kind: 'handeye',
        result, board: boardPayload(), dataset_path: datasetPath || null,
      });
      setStatus(t('common.saved', { path: p }));
    } catch (e) { setStatus(t('common.saveFailed', { error: e.message })); }
  };

  const onLoadYaml = async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      setResult({
        ok: true, rms: d.rms ?? 0,
        K: d.K || null, D: d.D || [], T: d.T || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0,
        // rms here is rotation rms (degrees); final_cost is translation rms (mm).
        // Prefer explicit rot_rms/pos_rms when the YAML carries them.
        final_cost: d.pos_rms ?? d.final_cost ?? 0,
        message: `loaded from ${p}`,
      });
      setStatus(t('common.loaded', { path: p }));
    } catch (e) { setStatus(t('common.loadFailed', { error: e.message })); }
  };

  const Tmat = result?.T ?? [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const tVec = [Tmat[0][3], Tmat[1][3], Tmat[2][3]];
  const tMm = tVec.map(v => v * 1000);
  const tNorm = Math.hypot(...tMm);

  const rpyDeg = (() => {
    const R = [[Tmat[0][0], Tmat[0][1], Tmat[0][2]],
               [Tmat[1][0], Tmat[1][1], Tmat[1][2]],
               [Tmat[2][0], Tmat[2][1], Tmat[2][2]]];
    const r = (v) => (v * 180) / Math.PI;
    const sy = Math.hypot(R[0][0], R[1][0]);
    if (sy < 1e-6) return [r(Math.atan2(-R[1][2], R[1][1])), r(Math.atan2(-R[2][0], sy)), 0];
    return [r(Math.atan2(R[2][1], R[2][2])), r(Math.atan2(-R[2][0], sy)), r(Math.atan2(R[1][0], R[0][0]))];
  })();

  const histData = useMemo(() => result?.per_frame_err ?? [], [result]);

  const rotRms = result?.ok ? result.rms : 0;
  const transRms = result?.ok ? result.final_cost : 0;
  // Traffic-light thresholds for hand-eye quality: rotation in degrees,
  // translation in millimetres. The overall pill reflects the worse axis.
  const HE_ROT_OK = 0.5, HE_ROT_WARN = 1.0;        // degrees
  const HE_TRANS_OK = 2.0, HE_TRANS_WARN = 5.0;    // mm
  const rotKind = result?.ok ? trafficKindForRms(rotRms, HE_ROT_OK, HE_ROT_WARN) : 'idle';
  const transKind = result?.ok ? trafficKindForRms(transRms, HE_TRANS_OK, HE_TRANS_WARN) : 'idle';
  const overallKind = result?.ok
    ? (rotKind === 'err' || transKind === 'err' ? 'err'
      : rotKind === 'warn' || transKind === 'warn' ? 'warn' : 'ok')
    : 'idle';
  const overallColor = trafficColor(overallKind);
  const vpW = 900, vpH = 620;

  // Coverage. Two sources, in order of preference:
  //   1. After solve — derive from per_frame_residuals + image_size, the
  //      authoritative "where on the sensor did detected boards actually
  //      land" view. Same path Intrinsics uses.
  //   2. During recording — fall back to the cells the live auto-capture
  //      callback has already claimed, so the user sees the grid fill
  //      out as they wave the rig around even before solving.
  // `tickCount` bumps once per auto-snap so the no-solve fallback re-renders.
  const [coverageTick, setCoverageTick] = useState(0);
  useEffect(() => { setCoverageTick(t => t + 1); }, [recordedCount]);
  const coverage = useMemo(() => {
    const fromSolve = computeCoverage(result?.per_frame_residuals, result?.image_size);
    if (fromSolve.filled > 0) return fromSolve;
    // Fallback: synthesize from snappedCellsRef so the grid lights up live.
    const total = fromSolve.total;
    const cells = new Array(total).fill(false);
    for (const idx of snappedCellsRef.current) {
      if (idx >= 0 && idx < total) cells[idx] = true;
    }
    const filled = cells.reduce((n, on) => n + (on ? 1 : 0), 0);
    return { cells, filled, total, percent: Math.round((filled / total) * 100) };
  }, [result, coverageTick]);

  const selectedPath = datasetFiles[selected - 1];

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>{t('handeye.railTitlePrefix', { tracker: trackerLabel })}</span>
          <span className="mono" style={{color:'var(--text-4)'}}>AX=XB</span>
        </div>
        <div className="rail-scroll">
          <CameraSourcePanel source={cam} onLivePreview={() => setViewMode('live')}/>
          <Section
            title={t('handeye.trackerSource')}
            hint={
              trackerSource === 'file'    ? (posesPath ? basename(posesPath) : t('handeye.pickJson')) :
              trackerSource === 'arx'     ? (arxDevice || t('handeye.pickDevice')) :
              trackerSource === 'oculus'  ? (oculusDevice || t('handeye.pickDevice')) :
              trackerSource === 'pico'    ? (picoDevice || t('handeye.pickDevice')) :
              trackerSource === 'ros2'    ? (trackerRos2Topic || t('handeye.pickTopic')) :
                                            (steamvrSerial || t('handeye.pickTracker'))
            }
          >
            <Field label={t('handeye.source')}>
              <select className="select" value={trackerSource} disabled={connected}
                onChange={e => setTrackerSource(e.target.value)}>
                {TRACKER_SOURCES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </Field>
            {trackerSource !== 'arx' && (
              <Field label={t('handeye.body')}>
                <select className="select" value={kind} disabled={connected}
                  onChange={e => setKind(e.target.value)}>
                  <option value="hmd">HMD</option>
                  <option value="ctrl">{t('handeye.trackerController')}</option>
                </select>
              </Field>
            )}
            {trackerSource === 'arx' && (
              <>
                <Field label={t('handeye.arm')}>
                  <select className="select" value={arxDevice} disabled={connected}
                    onChange={e => setArxDevice(e.target.value)}>
                    <option value="arx_ee_r">{t('handeye.armRight')}</option>
                    <option value="arx_ee_l">{t('handeye.armLeft')}</option>
                  </select>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                  {t('handeye.arxHint')}
                </div>
              </>
            )}
            {trackerSource === 'oculus' && (
              <>
                <Field label={t('handeye.device')}>
                  <select className="select" value={oculusDevice} disabled={connected}
                    onChange={e => setOculusDevice(e.target.value)}>
                    <option value="">{t('common.none')}</option>
                    <option value="quest3">Quest 3</option>
                    <option value="quest2">Quest 2</option>
                    <option value="questpro">Quest Pro</option>
                  </select>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                  {t('handeye.questHint')}
                </div>
              </>
            )}
            {trackerSource === 'pico' && (
              <>
                <Field label={t('handeye.device')}>
                  <select className="select" value={picoDevice} disabled={connected}
                    onChange={e => setPicoDevice(e.target.value)}>
                    <option value="">{t('common.none')}</option>
                    <option value="pico_ctrl_l">{t('handeye.controllerL')}</option>
                    <option value="pico_ctrl_r">{t('handeye.controllerR')}</option>
                    <option value="pico_hmd">{t('handeye.headset')}</option>
                  </select>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                  {t('handeye.picoHint')}
                </div>
              </>
            )}
            {trackerSource === 'ros2' && (
              <Ros2TopicPicker
                topic={trackerRos2Topic}
                onTopic={setTrackerRos2Topic}/>
            )}
            {trackerSource === 'steamvr' && (
              <>
                <Field label={t('handeye.serial')}>
                  <input className="input" value={steamvrSerial} placeholder={t('handeye.serialPlaceholder')} disabled={connected}
                    onChange={e => setSteamvrSerial(e.target.value)}/>
                </Field>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                  {t('handeye.steamvrHint')}
                </div>
              </>
            )}
            {trackerSource === 'file' && (
              <>
                <Field label={t('handeye.file')}>
                  <input className="input" value={posesPath} placeholder={t('handeye.filePlaceholder')}
                    onChange={e => setPosesPath(e.target.value)}/>
                </Field>
                <button className="btn" onClick={onPickPoses}>{t('handeye.pickJsonBtn')}</button>
              </>
            )}
            {(trackerSource === 'arx' || trackerSource === 'oculus' || trackerSource === 'pico' || trackerSource === 'steamvr') && (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  {!connected
                    ? <button className="btn primary" onClick={onConnectTracker}>{t('handeye.connect')}</button>
                    : <button className="btn ghost" onClick={onDisconnectTracker}>{t('handeye.disconnect')}</button>}
                </div>
                {connected && (
                  <div className="mono" style={{ fontSize: 10.5,
                    color: (poseStaleMs ?? 999) < 200 ? 'var(--ok)' : 'var(--warn)' }}>
                    ● {trackerDeviceKey()} · {poseHz} Hz · {poseStaleMs == null ? '—' : `${poseStaleMs} ms`}
                  </div>
                )}
              </>
            )}
          </Section>
          <Section title={t('handeye.dataset')} hint={datasetFiles.length ? t('common.images', { count: datasetFiles.length }) : t('common.notLoaded')}>
            <Field label={t('common.folder')}>
              <input className="input" value={datasetPath} placeholder={t('framePlaceholder.pathOrPlaceholder')}
                onChange={e => setDatasetPath(e.target.value)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
              <button className="btn" onClick={onPickDataset}>{t('handeye.pick')}</button>
              <button className="btn" disabled={!datasetPath}
                onClick={() => datasetPath && openPath(datasetPath)}>{t('handeye.open')}</button>
              <button className="btn ghost" onClick={() => { setDatasetPath(''); setDatasetFiles([]); }}>{t('common.clear')}</button>
            </div>
            {recordedCount > 0 && (
              <div className="mono" style={{ fontSize: 10.5, color:'var(--text-3)' }}>
                {t('handeye.posesEntries', { count: recordedCount })}
              </div>
            )}
          </Section>
          <Section title={t('handeye.cameraIntrinsics')} hint={camInt ? basename(camInt.path) : t('handeye.required')}>
            <button className="btn" onClick={onLoadIntrinsics}>{t('handeye.loadYamlCheck', { check: camInt ? '✓' : '' })}</button>
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title={t('handeye.method')} hint={`${solvePattern.replace('_', '-')} · ${method}`}>
            <Field label={t('handeye.pattern')}>
              <Seg value={solvePattern} onChange={setSolvePattern} full options={[
                {value:'eye_in_hand', label:t('handeye.eyeInHand')},
                {value:'eye_to_hand', label:t('handeye.eyeToHand')},
              ]}/>
            </Field>
            <Field label={t('handeye.methodLabel')}>
              <Seg value={method} onChange={setMethod} full options={[
                {value:'tsai',label:'Tsai'},{value:'park',label:'Park'},
                {value:'horaud',label:'Horaud'},{value:'daniilidis',label:'Dan.'},{value:'andreff',label:'Andreff'}
              ]}/>
            </Field>
          </Section>
          <CaptureControls
            autoCapture={autoCapture} onAuto={setAutoCapture}
            autoRate={autoCaptureRate} onAutoRate={setAutoCaptureRate}
            onSnap={onSnap} onDrop={onDrop}
            coverage={coverage.percent} coverageCells={coverage.cells}/>
        </div>
        <SolverButton onSolve={onRun} busy={busy} label={t('handeye.solveAxxb')}
          status={status}
          statusKind={
            !status ? undefined :
            statusErr ? 'err' :
            result?.ok ? 'ok' : 'warn'
          }/>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value={viewMode} onChange={setViewMode} options={[
            {value:'live',label:t('handeye.viewLive')},{value:'frame',label:t('handeye.viewFrame')},{value:'scene',label:t('handeye.viewScene')}
          ]}/>
          <Chk checked={showBoard} onChange={setShowBoard}>{t('handeye.board')}</Chk>
          <div className="spacer"/>
          <div className="read">
            {result?.ok
              ? <>{result.iterations > 0 && <>{t('handeye.pairs')} <b>{result.iterations}</b> · </>}rot <b style={{color: trafficColor(rotKind)}}>{rotRms.toFixed(3)}°</b> · trans <b style={{color: trafficColor(transKind)}}>{transRms.toFixed(2)} mm</b></>
              : <>{t('handeye.awaitingSolve')}</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selected}
          onSelect={(id) => { setSelected(id); setViewMode('frame'); }}
          coverage={coverage.percent}
          okBelow={HE_TRANS_OK} warnBelow={HE_TRANS_WARN}/>
        <div className="vp-body" style={{ gridTemplateColumns: '1fr 0.7fr', gap: 1, background: 'var(--view-border)' }}>
          <div className="vp-cell">
            <span className="vp-label">{t('handeye.sceneLabel')}</span>
            <Scene3D w={vpW*0.6} h={vpH}>
              {(cam) => {
                const Tboard = makeT(-Math.PI/2, 0, 0, 0, 0, -0.15);
                const T_tracker_cam = makeT(
                  rpyDeg[0] * Math.PI / 180, rpyDeg[1] * Math.PI / 180, rpyDeg[2] * Math.PI / 180,
                  tVec[0], tVec[1], tVec[2],
                );
                const Tcam = livePoseT ? composeT(livePoseT, T_tracker_cam) : null;
                return (
                  <g>
                    {showBoard && <Chessboard3D T={Tboard} cam={cam} cols={board.cols} rows={board.rows} sq={board.sq}/>}
                    {livePoseT && <TrackerGlyph T={livePoseT} cam={cam}/>}
                    {Tcam && <Frustum3D T={Tcam} cam={cam} fov={0.7} aspect={1.6} label="cam"/>}
                    {livePoseT && Tcam && (
                      <RigidLink3D a={applyT(livePoseT,[0,0,0])} b={applyT(Tcam,[0,0,0])} cam={cam} color="#e3bd56"/>
                    )}
                  </g>
                );
              }}
            </Scene3D>
          </div>
          <div className="vp-cell" style={{ background: 'var(--view-bg)', overflow:'hidden' }}>
            <span className="vp-label">{selectedPath ? t('handeye.camImageNamed', { name: basename(selectedPath) }) : t('handeye.camImage')}</span>
            {viewMode === 'live' && liveDevice ? (
              autoCapture
                ? <LiveDetectedFrame device={liveDevice} board={board}
                    showCorners={showBoard} showOrigin={true}
                    onMeta={onAutoMeta}/>
                : <LivePreview device={liveDevice}/>
            ) : selectedPath ? (
              <DetectedFrame path={selectedPath} board={board}
                showCorners={showBoard} showOrigin={true} overlay="none"/>
            ) : (
              <div className="mono" style={{
                display:'flex', alignItems:'center', justifyContent:'center',
                width:'100%', height:'100%', color:'var(--text-4)',
              }}>{t('handeye.noFramePick')}</div>
            )}
          </div>
        </div>
      </div>

      <div className="rail">
        <div className="rail-header">
          <span>{t('handeye.resultsPrefix', { label: xmatLabel })}</span>
          <span className="mono" style={{color: result?.ok ? overallColor : 'var(--text-4)'}}>
            {result?.ok ? `● ${rotRms.toFixed(2)}° / ${transRms.toFixed(1)} mm` : busy ? t('common.solvingDot') : t('common.idleDot')}
          </span>
        </div>
        <div className="rail-scroll">
          <Section title={t('handeye.transform')}>
            <Matrix m={Tmat}/>
            <KV items={[
              ['t  (mm)', `[ ${tMm[0].toFixed(1)}, ${tMm[1].toFixed(1)}, ${tMm[2].toFixed(1)} ]`, ''],
              ['rpy (°)', `[ ${rpyDeg[0].toFixed(3)}, ${rpyDeg[1].toFixed(3)}, ${rpyDeg[2].toFixed(3)} ]`, ''],
              ['||t||',   `${tNorm.toFixed(2)} mm`, 'pos'],
            ]}/>
          </Section>
          <ErrorPanel
            rms={rotRms} frames={frames.map(f => f.err)} histData={histData}
            title={t('handeye.rotationError')} unit="°"
            okBelow={HE_ROT_OK} warnBelow={HE_ROT_WARN}/>
          <ErrorPanel
            rms={transRms} frames={frames.map(f => f.err)} histData={histData}
            title={t('handeye.translationError')} unit="mm"
            okBelow={HE_TRANS_OK} warnBelow={HE_TRANS_WARN}/>
          <Section title={t('handeye.consistency')} hint={t('handeye.consistencyHint')}>
            <KV items={[
              [t('handeye.rotRms'),   `${rotRms.toFixed(3)}°`,    result?.ok ? (rotKind === 'ok' ? 'pos' : rotKind) : ''],
              [t('handeye.transRms'), `${transRms.toFixed(2)} mm`, result?.ok ? (transKind === 'ok' ? 'pos' : transKind) : ''],
              [t('handeye.nPairs'),   result?.iterations ? `${result.iterations}` : '—', ''],
            ]}/>
          </Section>
          <SolverPanel iters={result?.iterations || 0}
            cost={transRms} costUnit="mm" costLabel={t('handeye.transRms')}
            cond={0}
            algo={t('handeye.algo', { method })}/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoadYaml}>{t('common.load')}</button>
          <button className="btn primary" style={{flex:1}} onClick={onSaveYaml} disabled={!result?.ok}>{t('common.saveYaml')}</button>
        </div>
      </div>
    </div>
  );
}
