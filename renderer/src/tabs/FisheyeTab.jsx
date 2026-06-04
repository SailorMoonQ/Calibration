import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Section, Seg, Chk, Field, Matrix } from '../components/primitives.jsx';
import { DetectedFrame } from '../components/DetectedFrame.jsx';
import { RectifiedFrame } from '../components/RectifiedFrame.jsx';
import { RectifiedLivePreview } from '../components/RectifiedLivePreview.jsx';
import { LivePreview } from '../components/LivePreview.jsx';
import { LiveDetectedFrame } from '../components/LiveDetectedFrame.jsx';
import { useCameraSource, CameraSourcePanel } from '../components/CameraSource.jsx';
import {
  FrameStrip, ErrorPanel, TargetPanel,
  CaptureControls, SolverButton, SolverPanel,
  trafficKindForRms, trafficColor,
} from '../components/panels.jsx';
import { binPolar, pickGuidanceCell, totalPolarCells, polarCellAt, polarCellGeometry, boardTiltDeg, RINGS, SECTORS } from '../lib/polarCoverage.js';
import {
  GUIDED_STEPS, analyzeBoard, regionTarget, regionOk, poseOk,
  differsEnough, shotSignature,
} from '../lib/guidedSequence.js';
import { speak, createVoiceRecognizer } from '../lib/voice.js';

// A snapped board only counts as covering a (polar) cell when at least this many
// of its corners land in that cell — so a board merely clipping a cell's edge
// (or the live board sweeping past without a capture) does not turn it green.
const CAPTURE_MIN_CORNERS = 3;

// Hands-free auto-capture tuning. The board auto-snaps only when it is sharp,
// held still, and sitting in an under-sampled polar cell at a fresh tilt — and
// only after a short dwell, so you can sweep the board around and let it capture
// itself.
const TARGET_PER_CELL = 5;     // stop auto-snapping a cell once it has this many
const DWELL_MS = 500;          // must hold the good pose this long before it fires
const SHARP_REL = 0.40;        // reject if blurrier than this fraction of the session-best
const SHARP_ABS = 40;          // absolute Laplacian-variance floor
const TILT_MIN_DIFF = 4;       // a follow-up capture in a cell must differ in tilt by ≥ this (deg)
import { DEFAULT_CHESS_BOARD } from '../lib/board.js';
import { confirm } from '../components/confirm.jsx';
import { api, pickFolder, pickSaveFile, pickOpenFile } from '../api/client.js';

const ZERO_K = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]];

// Camera mount inferred from a ROS2 image source like
// "ros2:/camera/head/color/image_rect_compressed" → "head". When present, saving
// writes straight into the robot's shared camera_intrix.yaml under that mount.
const CAMERA_SLOT_RE = /\/camera\/(head|left|right|back)\//;
function cameraSlotFromSource(...sources) {
  for (const s of sources) {
    const m = CAMERA_SLOT_RE.exec(s || '');
    if (m) return m[1];
  }
  return null;
}

export function FisheyeTab({ tweaks }) {
  const { t } = useTranslation();
  const [board, setBoard] = useState(DEFAULT_CHESS_BOARD);
  const [model, setModel] = useState('equidistant');
  const [view, setView] = useState('split');
  const [showBoard, setShowBoard] = useState(true);
  const [showResid, setShowResid] = useState(true);
  const [balance, setBalance] = useState(0.6);
  const [fovScale, setFovScale] = useState(1.0);
  const [method, setMethod] = useState('remap'); // 'remap' | 'undistort'
  const [liveDetect, setLiveDetect] = useState(false);
  const [autoCapture, setAutoCapture] = useState(false);
  const [autoRate, setAutoRate] = useState(0.5);  // seconds between auto-snaps
  // 二选一的自动检测/叠加模式：'polar' 极坐标覆盖靶盘（手持扫覆盖），
  // 'guided' 文档引导序列（按手册清单逐个位置/动作各拍两张）。跨会话记住。
  const [captureMode, setCaptureMode] = useState(() => localStorage.getItem('calib_fisheye_capmode') || 'polar');
  const showPolar = captureMode === 'polar';
  const guidedMode = captureMode === 'guided';
  const [showFootprint, setShowFootprint] = useState(false); // 检测可达足迹热力
  // 镜像翻转：仅用于实时预览画面，不影响抓拍帧/校正视图/保存的原图。勾选状态跨会话记住。
  const [mirror, setMirror] = useState(() => localStorage.getItem('calib_fisheye_mirror') === '1');

  // Auto-detected fisheye image circle {cx,cy,r}, reported by LiveDetectedFrame.
  // Drives the polar dartboard, capture binning, and the FOV boundary.
  const [circle, setCircle] = useState(null);
  // Live capture coverage — grows only as the user SNAPS frames, before any
  // solve. `polarCounts[i]` = how many captured frames put a board into polar
  // cell i (≥ CAPTURE_MIN_CORNERS corners there). Reset per dataset (= per
  // capture session). After a solve we switch to residual-derived coverage.
  const [polarCounts, setPolarCounts] = useState(() => new Array(totalPolarCells()).fill(0));
  // Newest detection meta from the live stream, so a manual snap can bin the
  // corners it just saved into polarCounts (snap itself returns no corners).
  const latestMetaRef = useRef(null);

  // When onLoad sets datasetPath from a loaded calibration, the dataset-listing effect
  // would normally clear the just-loaded result. This ref tells the effect "skip the
  // result reset on the next listing — the result is fresh, not stale."
  const skipResultResetRef = useRef(false);

  const [datasetPath, setDatasetPath] = useState('');
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // status carries a message plus an explicit error flag, so the solver-status
  // color is language-independent (no regex-matching the localized text).
  const [status, setStatusMsg] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const setStatus = (msg, isErr = false) => { setStatusMsg(msg); setStatusErr(isErr); };

  const [viewMode, setViewMode] = useState('live'); // 'live' | 'frame'

  const cam = useCameraSource({
    pollEnabled: viewMode === 'live' || datasetFiles.length === 0,
  });
  const { liveDevice, streamInfo } = cam;

  const errByPath = useMemo(() => {
    if (!result?.ok) return null;
    const m = new Map();
    (result.detected_paths || []).forEach((p, i) => m.set(p, result.per_frame_err?.[i] ?? 0));
    return m;
  }, [result]);
  const residualsByPath = useMemo(() => {
    if (!result?.ok) return null;
    const m = new Map();
    (result.detected_paths || []).forEach((p, i) => m.set(p, result.per_frame_residuals?.[i]));
    return m;
  }, [result]);

  const imgSizeForCov = result?.image_size
    || (streamInfo?.open ? [streamInfo.width, streamInfo.height] : null);

  // The circle the polar grid is binned against. Prefer the auto-detected one;
  // fall back to a centred geometric circle (radius ≈ the image half-height,
  // matching the inscribed fisheye disk) until detection lands.
  const covCircle = useMemo(() => {
    if (circle) return circle;
    if (!imgSizeForCov) return null;
    const [w, h] = imgSizeForCov;
    if (!w || !h) return null;
    return { cx: w / 2, cy: h / 2, r: (Math.min(w, h) / 2) * 1.06 };
  }, [circle, imgSizeForCov?.[0], imgSizeForCov?.[1]]);

  // Polar coverage. Two sources, picked by phase:
  //   • after a solve → bin the per-frame residuals into rings×sectors, which
  //     also yields per-cell quality (mean reprojection error) for colouring.
  //   • during capture → the live `polarCounts` capture tally, so the dartboard
  //     fills in real time as the user snaps. `guidance` flags the emptiest cell.
  const coverage = useMemo(() => {
    const total = totalPolarCells();
    if (result?.per_frame_residuals?.length && covCircle) {
      const counts = new Array(total).fill(0);
      const errSum = new Array(total).fill(0);
      for (const frame of result.per_frame_residuals) {
        if (!frame) continue;
        for (const c of frame) {
          const idx = polarCellAt(c[0], c[1], covCircle);
          if (idx == null) continue;
          counts[idx] += 1;
          const ex = c[2], ey = c[3];
          if (Number.isFinite(ex) && Number.isFinite(ey)) errSum[idx] += Math.hypot(ex, ey);
        }
      }
      const cells = counts.map(n => n > 0);
      const meanErr = counts.map((n, i) => (n > 0 ? errSum[i] / n : null));
      const filled = cells.reduce((n, on) => n + (on ? 1 : 0), 0);
      return { cells, counts, meanErr, guidance: null, filled, total, percent: Math.round((filled / total) * 100) };
    }
    const cells = polarCounts.map(c => c > 0);
    const filled = cells.reduce((n, on) => n + (on ? 1 : 0), 0);
    return {
      cells, counts: polarCounts, meanErr: null,
      guidance: pickGuidanceCell(polarCounts),
      filled, total, percent: Math.round((filled / total) * 100),
    };
  }, [result, covCircle, polarCounts]);

  const frames = useMemo(() => datasetFiles.map((p, i) => ({
    id: i + 1, err: errByPath?.get(p) ?? 0, tx: 0, ty: 0, rot: 0,
  })), [datasetFiles, errByPath]);

  const [selected, setSelected] = useState(1);

  useEffect(() => {
    if (!datasetPath) return;
    let cancelled = false;
    api.listDataset(datasetPath).then(r => {
      if (cancelled) return;
      setDatasetFiles(r.files);
      setStatus(t('common.imagesInDataset', { count: r.count }));
      setSelected(1);
      if (skipResultResetRef.current) {
        // onLoad just brought a fresh calibration in tandem with this dataset path;
        // don't wipe it.
        skipResultResetRef.current = false;
      } else {
        setResult(null);
      }
    }).catch(e => !cancelled && setStatus(t('common.listingFailed', { error: e.message }), true));
    return () => { cancelled = true; };
  }, [datasetPath]);

  const boardPayload = () => ({
    type: board.type,
    cols: board.cols,
    rows: board.rows,
    square: board.sq,
    marker: board.marker ?? null,
    dictionary: 'DICT_5X5_100',
  });

  const onPickFolder = async () => {
    const p = await pickFolder(datasetPath || undefined);
    if (p) setDatasetPath(p);
  };

  const refreshDataset = async () => {
    if (!datasetPath) return;
    const r = await api.listDataset(datasetPath);
    setDatasetFiles(r.files);
    return r.files;
  };

  // Soft-delete every image in the folder to .trash/ (keeps the folder path).
  // Undoable as a single ⌘Z that restores them all.
  const onClear = async () => {
    if (!datasetPath || datasetFiles.length === 0) { setStatus(t('common.noImagesToRemove')); return; }
    const ok = await confirm({
      message: t('common.confirmClear', { count: datasetFiles.length }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    try {
      const r = await api.clearDataset(datasetPath);
      if (r.moved?.length) {
        pushUndo({ kind: 'clear', entries: r.moved.map(m => ({ path: m.path, trashPath: m.trash_path })) });
      }
      await refreshDataset();
      setSelected(1);
      setResult(null);
      setViewMode('live');
      setStatus(t('common.removedImages', { count: r.count }));
    } catch (e) { setStatus(t('common.clearFailed', { error: e.message }), true); }
  };

  // Refs that the global keydown handler reads from so it always sees the freshest
  // closures without re-attaching the listener on every render.
  const onSnapRef = useRef(null);
  const onUndoRef = useRef(null);
  const onDropRef = useRef(null);
  const onRunRef = useRef(null);
  const datasetCountRef = useRef(0);
  useEffect(() => { datasetCountRef.current = datasetFiles.length; }, [datasetFiles.length]);

  // Undo stack: bounded LIFO of {kind: 'snap'|'drop', path, trashPath?}.
  // - snap: undo deletes (trashes) the just-snapped file
  // - drop: undo restores from .trash/ back to original path
  const UNDO_LIMIT = 20;
  const undoStackRef = useRef([]);
  const pushUndo = (entry) => {
    const stack = undoStackRef.current;
    stack.push(entry);
    if (stack.length > UNDO_LIMIT) stack.shift();
  };

  // Smart auto-capture state. Rather than "new cell → snap", we gate on
  // sharpness + stillness + polar-novelty + a dwell timer, so the board can be
  // swept around hands-free and the app captures the good poses by itself.
  const lastAutoSnapRef = useRef(0);
  const autoSnapInFlightRef = useRef(false);
  const prevCornersRef = useRef(null);    // last frame's corners (for motion)
  const lastDetSeqRef = useRef(-1);       // last processed detection seq (skip repaints)
  const dwellStartRef = useRef(0);        // when the current good pose began
  const maxSharpRef = useRef(0);          // session-best sharpness (adaptive blur gate)
  // Per-cell list of captured board tilts (deg) — drives orientation diversity:
  // a 2nd/3rd capture in a cell only counts if its tilt is fresh.
  const cellTiltsRef = useRef(Array.from({ length: totalPolarCells() }, () => []));
  const [autoHud, setAutoHud] = useState(null);  // { reason, dwell:0..1, tilt, guidedLabel } for the on-frame badge

  // Guided-sequence progress (doc-driven mode). guidedStepRef indexes GUIDED_STEPS;
  // guidedShotsRef is how many of this step's shots are banked (0..shots);
  // guidedSigRef is the first shot's signature, so the 2nd shot can be required to
  // differ a little. guidedProgress mirrors the refs into state for the overlay/HUD.
  const guidedStepRef = useRef(0);
  const guidedShotsRef = useRef(0);
  const guidedSigRef = useRef(null);
  const [guidedProgress, setGuidedProgress] = useState({ step: 0, shots: 0 });
  const captureModeRef = useRef(captureMode);
  const resetGuided = () => {
    guidedStepRef.current = 0; guidedShotsRef.current = 0; guidedSigRef.current = null;
    setGuidedProgress({ step: 0, shots: 0 });
    dirStateRef.current = { dir: null, target: null, refDist: Infinity, lastSpeak: 0, arrived: false };
  };
  useEffect(() => {
    captureModeRef.current = captureMode;
    localStorage.setItem('calib_fisheye_capmode', captureMode);
    resetGuided();
  }, [captureMode]);

  useEffect(() => {
    setPolarCounts(new Array(totalPolarCells()).fill(0));
    cellTiltsRef.current = Array.from({ length: totalPolarCells() }, () => []);
    prevCornersRef.current = null;
    lastDetSeqRef.current = -1;
    dwellStartRef.current = 0;
    maxSharpRef.current = 0;
    dirStateRef.current = { dir: null, target: null, refDist: Infinity, lastSpeak: 0, arrived: false };
    resetGuided();
  }, [datasetPath]);

  // Board geometry in a ref so the per-frame handler reads current cols/rows
  // without being recreated when the board panel changes.
  const boardRef = useRef(board);
  useEffect(() => { boardRef.current = board; }, [board]);

  // Voice prompts (Edge-TTS clips, Chinese). Gated by settings; the per-snap
  // "captured" cue is rate-limited so rapid auto-captures don't stutter the audio.
  const voicePrompts = !!tweaks?.voicePrompts;
  const lastSpokeRef = useRef({});
  const voiceErrRef = useRef('');
  const say = useCallback((name, minGapMs = 0) => {
    if (!voicePrompts) return;
    const now = performance.now();
    if (minGapMs && now - (lastSpokeRef.current[name] || 0) < minGapMs) return;
    lastSpokeRef.current[name] = now;
    speak(name).catch((e) => {
      // AbortError ("play() interrupted by a new load request") is EXPECTED: a newer
      // cue intentionally cut this one off (one shared <audio>, prompts don't stack).
      // That's not a failure — swallow it. Only surface genuine blocks (autoplay
      // NotAllowedError, missing codec/device, …), de-duped so a persistent block
      // doesn't overwrite the status bar on every cue.
      if (e?.name === 'AbortError') return;
      const msg = e?.message || e?.name || 'play blocked';
      if (msg === voiceErrRef.current) return;
      voiceErrRef.current = msg;
      setStatus(t('fisheye.voicePlayFailed', { name, error: msg }), true);
    });
  }, [voicePrompts, t]);

  // Directional-guidance state machine (see steerVoice). mirrorRef lets the
  // spoken left/right match a mirrored display.
  const dirStateRef = useRef({ dir: null, target: null, refDist: Infinity, lastSpeak: 0, arrived: false });
  const mirrorRef = useRef(false);
  useEffect(() => {
    mirrorRef.current = mirror;
    localStorage.setItem('calib_fisheye_mirror', mirror ? '1' : '0');
  }, [mirror]);

  // Decide whether to speak a steering cue this frame. Event-driven: speak on a
  // new target, a changed direction, drifting the wrong way, or a stall — and go
  // quiet while the board is closing in. Announces arrival once.
  const steerVoice = useCallback(({ cell, reason, circle, curX, curY }) => {
    const guid = guidanceRef.current;
    const st = dirStateRef.current;
    if (st.target !== guid) { st.target = guid; st.dir = null; st.refDist = Infinity; st.arrived = false; }
    if (guid == null || !circle || cell == null) return;

    if (cell === guid) {                       // on the target cell
      if (!st.arrived) { st.arrived = true; say('onTarget'); }
      return;
    }
    st.arrived = false;
    if (reason !== 'enough') return;           // only steer off an already-full cell

    const g = polarCellGeometry(circle).find(x => x.index === guid);
    if (!g) return;
    const dx = g.x - curX, dy = g.y - curY;
    const dist = Math.hypot(dx, dy);
    const curR = Math.hypot(curX - circle.cx, curY - circle.cy);
    const gR = Math.hypot(g.x - circle.cx, g.y - circle.cy);
    let dir;
    if (gR - curR > circle.r * 0.33) dir = 'moveOut';
    else if (Math.abs(dx) > Math.abs(dy)) {
      const right = dx > 0;
      dir = (right !== mirrorRef.current) ? 'moveRight' : 'moveLeft';  // mirror swaps L/R
    } else dir = dy > 0 ? 'moveDown' : 'moveUp';

    const now = performance.now();
    const eps = circle.r * 0.06;
    const progressed = dist <= st.refDist - eps;
    const wrongWay = dist >= st.refDist + eps;
    let speakIt = false;
    if (dir !== st.dir) speakIt = now - st.lastSpeak > 900;        // new direction
    else if (wrongWay) speakIt = now - st.lastSpeak > 1500;        // drifting away
    else if (!progressed) speakIt = now - st.lastSpeak > 3500;     // stalled, no progress
    if (progressed) st.refDist = dist;                            // closing in → stay quiet
    if (speakIt) { say(dir); st.dir = dir; st.refDist = dist; st.lastSpeak = now; }
  }, [say]);

  // Directional voice for the guided sequence: steer the board toward an explicit
  // target point (the active step's region), with the same event-driven cadence as
  // steerVoice — speak on a new direction / drift / stall, stay quiet while closing
  // in. `stepKey` resets the progress baseline when the active step changes.
  const guidedSteer = useCallback((curX, curY, target, circle, stepKey) => {
    const st = dirStateRef.current;
    if (st.target !== stepKey) { st.target = stepKey; st.dir = null; st.refDist = Infinity; }
    if (curX == null || !circle || !target) return;
    const dx = target.x - curX, dy = target.y - curY;
    const dist = Math.hypot(dx, dy);
    const curR = Math.hypot(curX - circle.cx, curY - circle.cy);
    const gR = Math.hypot(target.x - circle.cx, target.y - circle.cy);
    let dir;
    if (gR - curR > circle.r * 0.33) dir = 'moveOut';
    else if (Math.abs(dx) > Math.abs(dy)) {
      const right = dx > 0;
      dir = (right !== mirrorRef.current) ? 'moveRight' : 'moveLeft';   // mirror swaps L/R
    } else dir = dy > 0 ? 'moveDown' : 'moveUp';
    const now = performance.now();
    const eps = circle.r * 0.06;
    const progressed = dist <= st.refDist - eps;
    const wrongWay = dist >= st.refDist + eps;
    let speakIt = false;
    if (dir !== st.dir) speakIt = now - st.lastSpeak > 900;
    else if (wrongWay) speakIt = now - st.lastSpeak > 1500;
    else if (!progressed) speakIt = now - st.lastSpeak > 3500;
    if (progressed) st.refDist = dist;
    if (speakIt) { say(dir); st.dir = dir; st.refDist = dist; st.lastSpeak = now; }
  }, [say]);

  // Keep the binning circle and live counts in refs so the per-frame auto-capture
  // handler reads the freshest values without being recreated every detection.
  const covCircleRef = useRef(null);
  useEffect(() => { covCircleRef.current = covCircle; }, [covCircle]);
  const polarCountsRef = useRef(polarCounts);
  useEffect(() => { polarCountsRef.current = polarCounts; }, [polarCounts]);
  const guidanceRef = useRef(null);   // the cell to steer the board toward (for spoken directions)
  useEffect(() => { guidanceRef.current = coverage.guidance; }, [coverage.guidance]);

  // Tally the just-snapped frame into the live polar coverage. Only cells the
  // board actually filled (≥ CAPTURE_MIN_CORNERS corners) are incremented, so
  // coverage reflects deliberate captures — not the live board sweeping past.
  // Uses the freshest live-detection meta (snap returns only a file path).
  const markCellsFromSnap = useCallback(({ silent = false } = {}) => {
    const meta = latestMetaRef.current;
    const c = covCircleRef.current;
    if (!meta?.corners?.length || !c) return;
    const perCell = binPolar(meta.corners, c);
    const b = boardRef.current;
    const tilt = boardTiltDeg(meta.corners, b.cols, b.rows);
    // record this capture's tilt in every cell it covered, for orientation diversity
    if (tilt != null) {
      perCell.forEach((cnt, i) => { if (cnt >= CAPTURE_MIN_CORNERS) cellTiltsRef.current[i].push(tilt); });
    }
    setPolarCounts(prev => {
      const next = prev.map((n, i) => n + (perCell[i] >= CAPTURE_MIN_CORNERS ? 1 : 0));
      // Spoken cues: a short "captured", and "coverage complete" the moment the
      // last cell crosses from empty to covered. Guided mode passes silent:true
      // and drives its own voice cadence (per-step, not per-cell).
      if (!silent) {
        say('captured', 600);
        const wasFull = prev.every(n => n > 0);
        if (!wasFull && next.every(n => n > 0)) say('allCovered');
      }
      return next;
    });
  }, [say]);

  const onAutoMeta = useCallback((meta) => {
    // Always stash the freshest meta so a manual snap can bin its corners,
    // even when auto-capture is off.
    latestMetaRef.current = meta;
    const corners = meta?.corners;
    const size = meta?.image_size;

    if (!autoCapture || !liveDevice || !datasetPath) { dwellStartRef.current = 0; return; }
    // Backend streams video faster than it detects, so the same detection arrives
    // on several frames. Run the capture/motion logic only on a FRESH detection,
    // else a moving board's repeated corners read as "still" and could mis-fire.
    if (meta?.det_seq != null && meta.det_seq === lastDetSeqRef.current) return;
    lastDetSeqRef.current = meta?.det_seq ?? lastDetSeqRef.current;
    const now = performance.now();

    // No full board in view → nothing to do; reset the dwell.
    if (!corners || corners.length < 4 || !size) {
      prevCornersRef.current = null; dwellStartRef.current = 0;
      setAutoHud({ reason: 'noBoard', dwell: 0 });
      return;
    }

    // 1) Motion: mean per-corner displacement vs the previous frame.
    const prev = prevCornersRef.current;
    let motion = Infinity;
    if (prev && prev.length === corners.length) {
      let s = 0;
      for (let i = 0; i < corners.length; i++) {
        s += Math.hypot(corners[i][0] - prev[i][0], corners[i][1] - prev[i][1]);
      }
      motion = s / corners.length;
    }
    prevCornersRef.current = corners;
    const motionThresh = Math.max(2, size[0] * 0.004);  // ≈ 3.8 px @ 960 wide
    const still = motion < motionThresh;

    // 2) Sharpness: adaptive — must be within SHARP_REL of the session best.
    const sharp = typeof meta.sharpness === 'number' ? meta.sharpness : null;
    if (sharp != null) maxSharpRef.current = Math.max(maxSharpRef.current, sharp);
    const sharpOk = sharp == null
      || sharp >= Math.max(SHARP_ABS, maxSharpRef.current * SHARP_REL);

    // ── Guided-sequence branch ────────────────────────────────────────────────
    // Doc-driven checklist: walk GUIDED_STEPS in order, two shots per action, the
    // 2nd required to differ a little from the 1st. Region + pose are matched
    // against the active step; we steer with voice/HUD until both are satisfied,
    // then dwell-snap. Shares the motion (still) + sharpness (sharpOk) gates above.
    if (captureModeRef.current === 'guided') {
      const debouncedG = now - lastAutoSnapRef.current >= Math.max(400, autoRate * 1000);
      const circleG = covCircleRef.current;
      const step = GUIDED_STEPS[guidedStepRef.current];
      if (!step) {                                  // whole sequence finished
        dwellStartRef.current = 0;
        setAutoHud({ reason: 'done', dwell: 0, guidedLabel: t('fisheye.guided.done') });
        return;
      }
      const shots = guidedShotsRef.current;
      const m = analyzeBoard(corners, boardRef.current, circleG);
      const rOk = regionOk(step, m, circleG);
      const pOk = poseOk(step, m);
      const needVary = shots === 1 && !differsEnough(guidedSigRef.current, m, circleG);

      let reason;
      if (!rOk) reason = 'region';
      else if (!pOk) reason = 'pose';
      else if (needVary) reason = 'vary';
      else if (!sharpOk) reason = 'blurry';
      else if (!still) reason = 'hold';
      else reason = 'capturing';

      // Voice steering: position first, then pose. Reuse the Chinese clips.
      if (!rOk) {
        guidedSteer(m.centroid?.x, m.centroid?.y, regionTarget(step.region, circleG), circleG, step.id);
      } else if (!pOk) {
        say('tiltHint', 4000);
      }

      const label = t('fisheye.guided.progress', {
        step: guidedStepRef.current + 1, total: GUIDED_STEPS.length,
        group: t(`fisheye.guided.groups.${step.group}`),
        action: t(`fisheye.guided.steps.${step.id}`),
        shot: shots + 1, shots: step.shots,
      });

      const readyG = rOk && pOk && !needVary && sharpOk && still && debouncedG && !autoSnapInFlightRef.current;
      if (!readyG) {
        if (reason !== 'capturing') dwellStartRef.current = 0;
        setAutoHud({ reason, dwell: 0, tilt: m.tilt, guidedLabel: label });
        return;
      }
      if (dwellStartRef.current === 0) dwellStartRef.current = now;
      const heldG = now - dwellStartRef.current;
      setAutoHud({ reason: 'capturing', dwell: Math.min(1, heldG / DWELL_MS), tilt: m.tilt, guidedLabel: label });
      if (heldG < DWELL_MS) return;

      autoSnapInFlightRef.current = true;
      lastAutoSnapRef.current = now;
      dwellStartRef.current = 0;
      const sigNow = shotSignature(m);
      (async () => {
        try {
          const r = await api.snap(liveDevice, datasetPath);
          pushUndo({ kind: 'snap', path: r.path });
          markCellsFromSnap({ silent: true });   // feed the fallback coverage % silently
          const newShots = shots + 1;
          if (newShots >= step.shots) {           // step done → advance
            guidedShotsRef.current = 0;
            guidedSigRef.current = null;
            guidedStepRef.current += 1;
            const done = guidedStepRef.current >= GUIDED_STEPS.length;
            say(done ? 'allCovered' : 'captured', 600);
            setGuidedProgress({ step: guidedStepRef.current, shots: 0 });
          } else {                                 // banked shot 1 → wait for a varied 2nd
            guidedShotsRef.current = newShots;
            guidedSigRef.current = sigNow;
            say('captured', 600);
            setGuidedProgress({ step: guidedStepRef.current, shots: newShots });
          }
          setStatus(t('common.autoSnapped', { name: r.path.split('/').pop(), cell: guidedStepRef.current }));
          const files = await refreshDataset();
          if (files) setSelected(files.length);
        } catch (e) {
          setStatus(t('common.autoSnapFailed', { error: e.message }), true);
        } finally {
          autoSnapInFlightRef.current = false;
        }
      })();
      return;
    }

    // 3) Novelty: the cell the board centroid sits in is still under-sampled,
    //    AND — once a cell has a capture — the board is at a *fresh tilt*, so we
    //    accumulate orientation diversity instead of three look-alike poses.
    const circle = covCircleRef.current;
    let sx = 0, sy = 0;
    for (const c of corners) { sx += c[0]; sy += c[1]; }
    const cell = circle ? polarCellAt(sx / corners.length, sy / corners.length, circle) : null;
    const counts = polarCountsRef.current;
    const b = boardRef.current;
    const tilt = boardTiltDeg(corners, b.cols, b.rows);
    const cellCount = cell != null ? (counts[cell] ?? 0) : TARGET_PER_CELL;
    const tilts = cell != null ? cellTiltsRef.current[cell] : [];
    // Freshness is judged against the MOST RECENT capture in this cell, not every
    // prior one. Comparing to all past tilts means that once you've swept the board
    // through a range of angles, every new angle lands within TILT_MIN_DIFF of *some*
    // earlier capture and the gate locks up ("换个倾斜角度" forever) even as you tilt
    // hard. Against just the last shot, an obvious tilt change always reads as fresh.
    const lastTilt = tilts.length ? tilts[tilts.length - 1] : null;
    const tiltFresh = tilt == null || lastTilt == null
      || Math.abs(lastTilt - tilt) >= TILT_MIN_DIFF;
    const underTarget = cell != null && cellCount < TARGET_PER_CELL;
    const novel = underTarget && (cellCount === 0 || tiltFresh);

    // 4) Debounce after a snap, and never overlap an in-flight snap.
    const debounced = now - lastAutoSnapRef.current >= Math.max(400, autoRate * 1000);

    let reason;
    if (cell != null && cellCount >= TARGET_PER_CELL) reason = 'enough';
    else if (underTarget && !tiltFresh) reason = 'tilt';   // need a different angle here
    else if (!sharpOk) reason = 'blurry';
    else if (!still) reason = 'hold';
    else reason = 'capturing';

    // Spoken directional guidance — event-driven, not on a fixed timer. We only
    // speak when it carries new information: the target cell changed, the
    // recommended direction changed, the board drifted the wrong way, or it
    // stalled with no progress. While the board is steadily approaching the
    // target we stay silent. Arriving on the target says "就这儿，稳住" once.
    steerVoice({
      cell, reason, circle,
      curX: sx / corners.length, curY: sy / corners.length,
    });

    const ready = novel && sharpOk && still && debounced && !autoSnapInFlightRef.current;
    if (!ready) {
      if (reason !== 'capturing') dwellStartRef.current = 0;
      if (reason === 'tilt') say('tiltHint', 4000);
      setAutoHud({ reason, dwell: 0, tilt });
      return;
    }

    // 5) Dwell: hold the good pose for DWELL_MS before firing.
    if (dwellStartRef.current === 0) dwellStartRef.current = now;
    const held = now - dwellStartRef.current;
    setAutoHud({ reason: 'capturing', dwell: Math.min(1, held / DWELL_MS), tilt });
    if (held < DWELL_MS) return;

    autoSnapInFlightRef.current = true;
    lastAutoSnapRef.current = now;
    dwellStartRef.current = 0;
    (async () => {
      try {
        const r = await api.snap(liveDevice, datasetPath);
        pushUndo({ kind: 'snap', path: r.path });
        markCellsFromSnap();
        setStatus(t('common.autoSnapped', { name: r.path.split('/').pop(), cell: cell ?? 0 }));
        const files = await refreshDataset();
        if (files) setSelected(files.length);
      } catch (e) {
        setStatus(t('common.autoSnapFailed', { error: e.message }), true);
      } finally {
        autoSnapInFlightRef.current = false;
      }
    })();
  }, [autoCapture, liveDevice, datasetPath, autoRate, say, markCellsFromSnap, steerVoice, guidedSteer, t]);

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

  // Undo the last destructive action. Snap-undo trashes the just-snapped file;
  // drop-undo restores from the .trash/ directory it landed in.
  const onUndo = async () => {
    const stack = undoStackRef.current;
    if (!stack.length) { setStatus(t('common.nothingToUndo')); return; }
    const entry = stack.pop();
    try {
      if (entry.kind === 'snap') {
        await api.deleteFrame(entry.path);
        await refreshDataset();
        setStatus(t('common.undidSnap', { name: entry.path.split('/').pop() }));
      } else if (entry.kind === 'drop') {
        await api.restoreFrame(entry.trashPath, entry.path);
        await refreshDataset();
        setStatus(t('common.undidDrop', { name: entry.path.split('/').pop() }));
      } else if (entry.kind === 'clear') {
        for (const e of entry.entries) await api.restoreFrame(e.trashPath, e.path);
        await refreshDataset();
        setStatus(t('common.undidClear', { count: entry.entries.length }));
      }
    } catch (e) {
      stack.push(entry);  // put it back so the user can retry
      setStatus(t('common.undoFailed', { error: e.message }), true);
    }
  };

  // Keyboard shortcuts: ←/→ step through dataset frames; space snaps a new frame.
  // Skip while focus is on a form control so typing in fields stays unaffected.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || t?.isContentEditable) {
        return;
      }
      if (e.key === 'ArrowRight') {
        if (datasetCountRef.current === 0) return;
        e.preventDefault();
        setSelected(s => Math.min(datasetCountRef.current, s + 1));
        setViewMode('frame');
      } else if (e.key === 'ArrowLeft') {
        if (datasetCountRef.current === 0) return;
        e.preventDefault();
        setSelected(s => Math.max(1, s - 1));
        setViewMode('frame');
      } else if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        onSnapRef.current?.();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        onUndoRef.current?.();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDropRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Advance the guided checklist by one banked shot. Auto-capture advances inline
  // in onAutoMeta; this keeps manual (space-bar) snaps in guided mode in sync so
  // the overlay/HUD step doesn't stall while the user shoots by hand.
  const advanceGuidedShot = () => {
    const step = GUIDED_STEPS[guidedStepRef.current];
    if (!step) return;
    const m = analyzeBoard(latestMetaRef.current?.corners, boardRef.current, covCircleRef.current);
    const shots = guidedShotsRef.current;
    const newShots = shots + 1;
    if (newShots >= step.shots) {
      guidedShotsRef.current = 0; guidedSigRef.current = null; guidedStepRef.current += 1;
      setGuidedProgress({ step: guidedStepRef.current, shots: 0 });
    } else {
      guidedShotsRef.current = newShots; guidedSigRef.current = shotSignature(m);
      setGuidedProgress({ step: guidedStepRef.current, shots: newShots });
    }
  };

  const onSnap = async () => {
    let dir = datasetPath;
    if (!dir) {
      const picked = await pickFolder();
      if (!picked) { setStatus(t('common.pickSessionFolder'), true); return; }
      setDatasetPath(picked);
      dir = picked;
    }
    if (!liveDevice) { setStatus(t('common.pickCamera'), true); return; }
    const guided = captureModeRef.current === 'guided';
    try {
      const r = await api.snap(liveDevice, dir);
      pushUndo({ kind: 'snap', path: r.path });
      markCellsFromSnap({ silent: guided });
      if (guided) { advanceGuidedShot(); say('captured', 600); }
      setStatus(t('common.snapped', { name: r.path.split('/').pop() }));
      if (dir === datasetPath) {
        // Refresh the listing but keep the live view in the cell — the user is mid-capture
        // and shouldn't have the frame jump to the just-saved still. Click a thumbnail in
        // the FrameStrip to inspect a saved frame.
        await refreshDataset();
      }
    } catch (e) { setStatus(t('common.snapFailed', { error: e.message }), true); }
  };
  // Keep refs pointed at the latest closures so the global keydown handler
  // always invokes the up-to-date functions (which close over liveDevice / datasetPath).
  useEffect(() => { onSnapRef.current = onSnap; });
  useEffect(() => { onUndoRef.current = onUndo; });
  useEffect(() => { onDropRef.current = onDrop; });
  useEffect(() => { onRunRef.current = onRun; });

  // Voice commands (browser SpeechRecognition). Active only while the setting is
  // on and a camera is live. Keywords map to the same actions as the buttons.
  const voiceCommands = !!tweaks?.voiceCommands;
  useEffect(() => {
    if (!voiceCommands || !liveDevice) return;
    const rec = createVoiceRecognizer({
      onCommand: (action) => {
        if (action === 'snap') onSnapRef.current?.();
        else if (action === 'solve') onRunRef.current?.();
        else if (action === 'undo') onUndoRef.current?.();
        else if (action === 'drop') onDropRef.current?.();
      },
      onState: (s) => {
        if (s === 'listening') say('listening', 3000);
        else if (s.startsWith('error:')) {
          const err = s.slice(6);
          // 'no-speech' / 'aborted' fire constantly and are benign — don't nag.
          if (err !== 'no-speech' && err !== 'aborted') {
            setStatus(t('fisheye.voiceError', { error: err }), true);
          }
        }
      },
    });
    if (!rec.supported) { setStatus(t('tweaks.voiceUnsupported'), true); return; }
    rec.start();
    return () => rec.stop();
  }, [voiceCommands, liveDevice, say, t]);

  const onRun = async () => {
    if (!datasetPath) { setStatus(t('common.pickDatasetFolder'), true); return; }
    setBusy(true); setStatus(t('fisheye.solving')); say('solveStart');
    try {
      const res = await api.calibrate('fisheye', {
        board: boardPayload(),
        model,
        dataset_path: datasetPath,
      });
      setResult(res);
      setStatus(res.ok ? t('fisheye.rmsResult', { rms: res.rms.toFixed(4), message: res.message }) : t('common.failed', { message: res.message }), !res.ok);
      say(res.ok ? 'solveOk' : 'solveFail');
    } catch (e) { setStatus(t('common.error', { error: e.message }), true); say('solveFail'); } finally { setBusy(false); }
  };

  const onSave = async () => {
    if (!result?.ok) { setStatus(t('common.nothingToSave')); return; }
    // Extra layer (not a replacement): when the source is a ROS2 camera, the mount
    // (head/left/right/back) lives in the topic, so also merge this solve into the
    // robot's shared camera_intrix.yaml — other mounts + their sn untouched, old
    // file backed up. The original pick-a-file YAML export below is unchanged.
    const slot = cameraSlotFromSource(liveDevice, datasetPath);
    let extra = '', extraErr = false;
    if (slot) {
      try {
        const r = await api.exportCameraIntrix({ slot, K: result.K, D: result.D ?? [] });
        extra = ' · ' + t('fisheye.wroteCameraIntrix', { slot, path: r.path });
      } catch (e) {
        extra = ' · ' + t('fisheye.cameraIntrixFailed', { error: e.message });
        extraErr = true;
      }
    }
    const p = await pickSaveFile({ defaultPath: 'fisheye.yaml' });
    // Dialog cancelled — the camera_intrix write (if any) already happened, so
    // surface that rather than dropping the feedback silently.
    if (!p) { if (extra) setStatus(extra.slice(3), extraErr); return; }
    try {
      await api.saveCalibration({
        path: p, kind: 'fisheye',
        result, board: boardPayload(), dataset_path: datasetPath || null,
      });
      const fmt = p.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      setStatus(t('common.savedFmt', { fmt, path: p }) + extra);
    } catch (e) { setStatus(t('common.saveFailed', { error: e.message }), true); }
  };

  const onLoad = async () => {
    const p = await pickOpenFile({});
    if (!p) return;
    try {
      const resp = await api.loadCalibration(p);
      const d = resp.data || {};
      const Kload = d.K || null;
      const Dload = d.D || [];
      setResult({
        ok: true,
        rms: d.rms ?? 0,
        K: Kload, D: Dload,
        image_size: d.image_size || null,
        per_frame_err: d.frames?.per_frame_err || [],
        per_frame_residuals: [], detected_paths: [],
        iterations: 0, final_cost: 0,
        message: `loaded from ${p}`,
      });
      if (d.dataset_path && d.dataset_path !== datasetPath) {
        // Tell the dataset-listing effect not to clear the result we just set above.
        skipResultResetRef.current = true;
        setDatasetPath(d.dataset_path);
      }
      // Snap the viewport into split + live so the user immediately sees the
      // raw camera + rectified preview built from the just-loaded intrinsics.
      setView('split');
      setViewMode('live');
      const fmt = p.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      const fxRound = Kload?.[0]?.[0]?.toFixed?.(1) ?? '?';
      const rmsRound = (d.rms ?? 0).toFixed(3);
      setStatus(t('fisheye.loadedDetail', { fmt, name: p.split('/').pop(), rms: rmsRound, fx: fxRound }));
    } catch (e) { setStatus(t('common.loadFailed', { error: e.message }), true); }
  };

  const rms = result?.ok ? result.rms : 0;
  // Fisheye reprojection-error thresholds (pixels). Same scale as pinhole.
  const PX_OK = 0.25, PX_WARN = 0.5;
  const rmsKind = result?.ok ? trafficKindForRms(rms, PX_OK, PX_WARN) : 'idle';
  const Kraw = result?.K ?? null;
  const K44 = Kraw
    ? [[...Kraw[0], 0], [...Kraw[1], 0], [...Kraw[2], 0], [0,0,0,1]]
    : ZERO_K;
  const D = result?.D ?? [];

  const histData = result?.per_frame_err ?? [];
  const sparkData = useMemo(() => frames.map(f => f.err), [frames]);

  const selectedPath = datasetFiles[selected - 1];
  const calibrated = !!(result?.ok && Kraw && D.length);
  const canRectifyFrame = !!(calibrated && selectedPath);

  const emptyCell = (text) => (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      width:'100%', height:'100%', color:'var(--view-text-2)',
      fontFamily:'JetBrains Mono', fontSize: 11, padding: 16, textAlign: 'center',
    }}>{text}</div>
  );

  // Live preview takes priority when the user is in 'live' mode OR when there's no dataset
  // to fall back on. Snapping a frame flips viewMode to 'frame' so they see the saved image;
  // clicking "👁 live preview" puts them back to live.
  const showLive = liveDevice && (viewMode === 'live' || datasetFiles.length === 0);

  // Guided overlay descriptor for the live frame: the active step's region + pose
  // glyph, or {done:true} once the checklist is exhausted. null in polar mode.
  const guidedStepNow = GUIDED_STEPS[guidedProgress.step];
  const guidedOverlay = guidedMode
    ? (guidedStepNow
        ? { region: guidedStepNow.region, glyph: guidedStepNow.glyph,
            pose: guidedStepNow.pose, scale: guidedStepNow.scale ?? null,
            group: guidedStepNow.group, done: false }
        : { done: true })
    : null;

  const rawCell = (
    <div className="vp-cell" key="raw">
      <span className="vp-label">
        {showLive ? t('fisheye.liveLabel', { device: liveDevice }) : t('fisheye.rawDistorted')}
      </span>
      {showLive ? (
        liveDetect
          ? <LiveDetectedFrame device={liveDevice} board={board}
                showCorners={showBoard} showOrigin={true}
                onMeta={onAutoMeta}
                onCircle={setCircle}
                showPolarGrid={showPolar}
                polarCells={coverage.cells}
                polarCounts={coverage.counts}
                polarGuidance={coverage.guidance}
                polarTarget={TARGET_PER_CELL}
                rings={RINGS} sectors={SECTORS}
                guided={guidedOverlay}
                showFootprint={showFootprint}
                mirror={mirror}/>
          : <LivePreview device={liveDevice} mirror={mirror}/>
      ) : datasetFiles.length > 0 && selectedPath ? (
        <DetectedFrame
          path={selectedPath}
          board={board}
          showCorners={showBoard}
          showOrigin={true}
          overlay={showResid ? 'residuals' : 'none'}
          residuals={residualsByPath?.get(selectedPath)}/>
      ) : (
        emptyCell(t('fisheye.connectOrLoad'))
      )}
      {showLive && liveDetect && autoCapture && autoHud && (() => {
        const r = autoHud.reason;
        const color = r === 'capturing' ? 'var(--ok)' : r === 'blurry' || r === 'noBoard' ? 'var(--warn)' : 'var(--text-2)';
        return (
          <div style={{
            position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(8,10,14,0.82)', border: `1.5px solid ${color}`, borderRadius: 7,
            padding: '7px 13px', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 168,
            fontFamily: 'JetBrains Mono', fontSize: 12.5, fontWeight: 600, color,
            boxShadow: '0 3px 14px rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)',
            textShadow: '0 1px 2px rgba(0,0,0,0.7)',
          }}>
            {autoHud.guidedLabel && (
              <div style={{ color: 'var(--text)', fontSize: 12, fontWeight: 700 }}>{autoHud.guidedLabel}</div>
            )}
            <div>⦿ {t('fisheye.autoCapture')} · {t(`fisheye.auto_${r}`)}
              {typeof autoHud.tilt === 'number' && <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>  ∠{autoHud.tilt.toFixed(0)}°</span>}
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.18)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round((autoHud.dwell || 0) * 100)}%`, background: 'var(--ok)', transition: 'width 80ms linear' }}/>
            </div>
          </div>
        );
      })()}
      <div className="vp-corner-read">
        <div>fx <b>{K44[0][0].toFixed(2)}</b>  fy <b>{K44[1][1].toFixed(2)}</b></div>
        <div>cx <b>{K44[0][2].toFixed(2)}</b>  cy <b>{K44[1][2].toFixed(2)}</b></div>
        <div>k₁ <b>{(D[0] ?? 0).toFixed(4)}</b>  k₂ <b>{(D[1] ?? 0).toFixed(4)}</b></div>
        <div>k₃ <b>{(D[2] ?? 0).toFixed(4)}</b>  k₄ <b>{(D[3] ?? 0).toFixed(4)}</b></div>
      </div>
    </div>
  );

  // Rectified cell. Source picks itself: live mode + calibrated → live MJPEG rectified;
  // dataset frame selected + calibrated → that frame rectified; otherwise placeholder.
  const rectifiedCell = (m, label) => {
    const useLive = showLive && calibrated && liveDevice;
    let body;
    if (useLive) {
      body = <RectifiedLivePreview device={liveDevice} K={Kraw} D={D}
                balance={balance} fovScale={fovScale} method={m}/>;
    } else if (canRectifyFrame) {
      body = <RectifiedFrame path={selectedPath} K={Kraw} D={D}
                balance={balance} fovScale={fovScale} method={m}/>;
    } else if (calibrated) {
      body = emptyCell(t('fisheye.connectOrSelectFrame'));
    } else {
      body = emptyCell(t('fisheye.runToRectify'));
    }
    return (
      <div className="vp-cell" key={m}>
        <span className="vp-label">{useLive ? t('fisheye.liveSuffix', { label }) : label}</span>
        {body}
        <div className="vp-corner-read">
          <div>{t('fisheye.method')} <b>{m === 'undistort' ? t('fisheye.methodCvUndistort') : t('fisheye.methodRemapFull')}</b></div>
          <div>{t('fisheye.balanceRead')} <b>{balance.toFixed(2)}</b>  {t('fisheye.fovScaleRead')} <b>{fovScale.toFixed(2)}</b></div>
        </div>
      </div>
    );
  };

  const rectCell = rectifiedCell(method, method === 'undistort' ? t('fisheye.rectifiedUndistort') : t('fisheye.rectifiedRemap'));

  return (
    <div className="workspace">
      <div className="rail">
        <div className="rail-header">
          <span>{t('fisheye.railTitle')}</span>
          <span className="mono" style={{color: result?.ok ? trafficColor(rmsKind) : 'var(--text-4)'}}>
            {result?.ok ? t('common.rmsPx', { rms: result.rms.toFixed(2) }) : t('common.idle')}
          </span>
        </div>
        <div className="rail-scroll">
          <CameraSourcePanel source={cam} onLivePreview={() => setViewMode('live')}/>
          <Section title={t('fisheye.dataset')} hint={datasetFiles.length ? t('common.images', { count: datasetFiles.length }) : t('common.notLoaded')}>
            <Field label={t('common.folder')}>
              <input className="input" value={datasetPath} placeholder={t('framePlaceholder.pathOrPlaceholder')}
                     onChange={e => setDatasetPath(e.target.value)}/>
            </Field>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              <button className="btn" onClick={onPickFolder}>{t('common.pickFolder')}</button>
              <button className="btn ghost" onClick={onClear}>{t('common.clear')}</button>
            </div>
            {status && <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>{status}</div>}
          </Section>
          <TargetPanel board={board} onBoard={setBoard}/>
          <Section title={t('fisheye.projectionModel')} hint={model}>
            <Seg value={model} onChange={setModel} full options={[
              {value:'equidistant',label:t('fisheye.modelEquidistant')},{value:'kb',label:t('fisheye.modelKb')},{value:'omni',label:t('fisheye.modelOmni')}
            ]}/>
            <Chk checked={true} onChange={()=>{}}>{t('fisheye.estimateK')}</Chk>
            <Chk checked={false} onChange={()=>{}}>{t('fisheye.includeXi')}</Chk>
            <Chk checked={true} onChange={()=>{}}>{t('fisheye.bundleAdjust')}</Chk>
            <Chk checked={true} onChange={()=>{}}>{t('fisheye.applyFovMask')}</Chk>
          </Section>
          <Section title={t('fisheye.undistortionPreview')}>
            <Field label={t('fisheye.balance')}>
              <div className="slider-row">
                <input type="range" min="0" max="100" value={Math.round(balance * 100)}
                       onChange={e => setBalance(+e.target.value / 100)}/>
                <span className="mono">{balance.toFixed(2)}</span>
              </div>
            </Field>
            <Field label={t('fisheye.fovScale')}>
              <div className="slider-row">
                <input type="range" min="10" max="300" value={Math.round(fovScale * 100)}
                       onChange={e => setFovScale(+e.target.value / 100)}/>
                <span className="mono">{fovScale.toFixed(2)}</span>
              </div>
            </Field>
          </Section>
          <CaptureControls
            autoCapture={autoCapture}
            onAuto={(v) => {
              setAutoCapture(v);
              // Auto-capture relies on the per-frame detection stream, so flip
              // liveDetect on alongside it. Leaving liveDetect off would render
              // the toggle silently inert.
              if (v) setLiveDetect(true);
              else { setAutoHud(null); dwellStartRef.current = 0; }
            }}
            autoRate={autoRate}
            onAutoRate={setAutoRate}
            onSnap={onSnap} onDrop={onDrop}
            coverage={coverage.percent}
            polar={{ cells: coverage.cells, counts: coverage.counts, meanErr: coverage.meanErr,
                     guidance: coverage.guidance, rings: RINGS, sectors: SECTORS }}
            okBelow={PX_OK} warnBelow={PX_WARN}/>
        </div>
        <SolverButton onSolve={onRun} busy={busy}
          status={status}
          statusKind={
            !status ? undefined :
            statusErr ? 'err' :
            result?.ok ? 'ok' : 'warn'
          }/>
      </div>

      <div className="viewport">
        <div className="vp-toolbar">
          <Seg value={view} onChange={setView} options={[
            {value:'split',label:t('fisheye.viewSplit')},
            {value:'raw',label:t('fisheye.viewRaw')},
            {value:'rect',label:t('fisheye.viewRectified')},
            {value:'compare',label:t('fisheye.viewCompare')},
          ]}/>
          {view !== 'compare' && view !== 'raw' && (
            <Seg value={method} onChange={setMethod} options={[
              {value:'remap',label:t('fisheye.methodRemap')},
              {value:'undistort',label:t('fisheye.methodUndistort')},
            ]}/>
          )}
          <Chk checked={showBoard} onChange={setShowBoard}>{t('fisheye.board')}</Chk>
          <Chk checked={showResid} onChange={setShowResid}>{t('fisheye.residuals')}</Chk>
          <Chk checked={liveDetect} onChange={setLiveDetect}>{t('fisheye.detectLive')}</Chk>
          <Seg value={captureMode} onChange={(v) => { setCaptureMode(v); setLiveDetect(true); }} options={[
            {value:'polar',label:t('fisheye.captureModePolar')},
            {value:'guided',label:t('fisheye.captureModeGuided')},
          ]}/>
          <Chk checked={showFootprint} onChange={(v) => { setShowFootprint(v); if (v) setLiveDetect(true); }}>{t('fisheye.footprint')}</Chk>
          <Chk checked={mirror} onChange={setMirror}>{t('fisheye.mirror')}</Chk>
          <div className="spacer"/>
          <div className="read">
            {streamInfo?.open && (
              <>{streamInfo.width}×{streamInfo.height} · <b>{streamInfo.capture_fps?.toFixed(1) ?? '—'}</b> fps · </>
            )}
            {result?.ok ? <>rms <b style={{color: trafficColor(rmsKind)}}>{result.rms.toFixed(3)}</b> px</> : <>{t('fisheye.noCalibrationYet')}</>}
          </div>
        </div>
        <FrameStrip frames={frames} selected={selected} onSelect={(id) => { setSelected(id); setViewMode('frame'); }} coverage={coverage.percent}/>
        {(() => {
          // Pick which cells to render. Until we have intrinsics, the rectified cell is
          // not meaningful — collapse to the raw cell at full width regardless of view mode.
          let cells;
          if (!calibrated) {
            cells = [rawCell];
          } else if (view === 'compare') {
            cells = [
              rectifiedCell('remap', t('fisheye.rectifiedRemapFull')),
              rectifiedCell('undistort', t('fisheye.rectifiedUndistortFull')),
            ];
          } else if (view === 'raw') {
            cells = [rawCell];
          } else if (view === 'rect') {
            cells = [rectCell];
          } else { // 'split'
            cells = [rawCell, rectCell];
          }
          const cols = cells.length === 2 ? '1fr 1fr' : '1fr';
          return (
            <div className="vp-body vp-split" style={{ gridTemplateColumns: cols }}>
              {cells}
            </div>
          );
        })()}
      </div>

      <div className="rail">
        <div className="rail-header"><span>{t('fisheye.results')}</span>
          <span className="mono" style={{color: result?.ok ? trafficColor(rmsKind) : 'var(--text-4)'}}>
            {result?.ok ? `● ${rms.toFixed(2)} px` : busy ? t('common.solvingDot') : t('common.idleDot')}
          </span>
        </div>
        <div className="rail-scroll">
          <ErrorPanel rms={rms} frames={sparkData} histData={histData}
            okBelow={PX_OK} warnBelow={PX_WARN}/>
          <Section title={t('fisheye.kFisheye')}>
            <Matrix m={K44}/>
          </Section>
          <Section title={t('fisheye.distortionK')} hint={model}>
            <div className="mono" style={{ fontSize: 11.5, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
              {['k₁','k₂','k₃','k₄'].map((lbl, i) => (
                <React.Fragment key={i}>
                  <span style={{color:'var(--text-3)'}}>{lbl}</span>
                  <span style={{textAlign:'right'}}>{(D[i] ?? 0).toFixed(5)}</span>
                </React.Fragment>
              ))}
            </div>
          </Section>
          <SolverPanel
            iters={result?.iterations ?? 0}
            cost={result?.final_cost ?? 0} costUnit="px²"
            cond={0}
            algo={t('fisheye.algo')}/>
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)', background: 'var(--surface-2)', display: 'flex', gap: 6 }}>
          <button className="btn" style={{flex:1}} onClick={onLoad}>{t('common.load')}</button>
          <button className="btn primary" style={{flex:1}} onClick={onSave} disabled={!result?.ok}>{t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}
