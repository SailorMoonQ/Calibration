import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeBoard, boardTiltDeg } from '../boardMetrics.js';
import {
  GUIDED_STEPS, regionTarget, regionOk, poseOk, differsEnough, shotSignature,
} from '../guidedSequence.js';

// A snapped board only counts as covering a cell when at least this many of its
// corners land in that cell — so a board merely clipping a cell's edge (or the
// live board sweeping past without a capture) does not turn it green.
export const CAPTURE_MIN_CORNERS = 3;

// Hands-free auto-capture tuning. The board auto-snaps only when it is sharp,
// held still, and sitting in an under-sampled cell at a fresh tilt — and only
// after a short dwell, so you can sweep the board around and let it capture
// itself. None of these depend on the lens: the circle-vs-rectangle difference
// lives entirely in the injected `geometry` adapter.
const TARGET_PER_CELL = 5;     // stop auto-snapping a cell once it has this many
const DWELL_MS = 500;          // must hold the good pose this long before it fires
const SHARP_REL = 0.40;        // reject if blurrier than this fraction of the session-best
const SHARP_ABS = 40;          // absolute Laplacian-variance floor
const TILT_MIN_DIFF = 4;       // a follow-up capture in a cell must differ in tilt by ≥ this (deg)

export function useSmartCapture({
  enabled, liveDevice, datasetPath, autoRate = 0.5,
  board, geometry, profile, mode = 'sweep', mirror = false, guidance = null,
  doSnap, onCaptured, say, t, setStatus,
}) {
  // `poseOk` defaults its profile arg to FISHEYE_PROFILE — a caller that forgets
  // to pass one silently gets fisheye thresholds on a pinhole board. This hook is
  // the first caller shared by both tabs, so require the profile explicitly
  // rather than letting that default paper over a missing prop.
  if (!profile) throw new Error('useSmartCapture: profile is required (FISHEYE_PROFILE or PINHOLE_PROFILE)');

  const [counts, setCounts] = useState(() => new Array(geometry.totalCells).fill(0));
  const [autoHud, setAutoHud] = useState(null);
  const [guidedProgress, setGuidedProgress] = useState({ step: 0, shots: 0 });

  // Everything the per-frame handler reads goes through a ref, so `onMeta` keeps
  // a stable identity and the websocket inside LiveDetectedFrame is never torn
  // down and rebuilt just because a toggle changed.
  const geomRef = useRef(geometry);
  const boardRef = useRef(board);
  const modeRef = useRef(mode);
  const mirrorRef = useRef(mirror);
  const profileRef = useRef(profile);
  const countsRef = useRef(counts);
  const guidanceRef = useRef(guidance);
  const enabledRef = useRef(enabled);
  const deviceRef = useRef(liveDevice);
  const datasetRef = useRef(datasetPath);
  const rateRef = useRef(autoRate);
  const doSnapRef = useRef(doSnap);
  const onCapturedRef = useRef(onCaptured);
  useEffect(() => { geomRef.current = geometry; }, [geometry]);
  useEffect(() => { boardRef.current = board; }, [board]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { mirrorRef.current = mirror; }, [mirror]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { countsRef.current = counts; }, [counts]);
  useEffect(() => { guidanceRef.current = guidance; }, [guidance]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { deviceRef.current = liveDevice; }, [liveDevice]);
  useEffect(() => { datasetRef.current = datasetPath; }, [datasetPath]);
  useEffect(() => { rateRef.current = autoRate; }, [autoRate]);
  useEffect(() => { doSnapRef.current = doSnap; }, [doSnap]);
  useEffect(() => { onCapturedRef.current = onCaptured; }, [onCaptured]);

  const sayRef = useRef(say);
  const tRef = useRef(t);
  const setStatusRef = useRef(setStatus);
  useEffect(() => { sayRef.current = say; }, [say]);
  useEffect(() => { tRef.current = t; }, [t]);
  useEffect(() => { setStatusRef.current = setStatus; }, [setStatus]);

  // Newest detection meta from the live stream, so a manual snap can bin the
  // corners it just saved (snap itself returns no corners).
  const latestMetaRef = useRef(null);
  const lastAutoSnapRef = useRef(0);
  const snapInFlightRef = useRef(false);  // blocks both auto and manual snaps
  const prevCornersRef = useRef(null);    // last frame's corners (for motion)
  const lastDetSeqRef = useRef(-1);       // last processed detection seq (skip repaints)
  const dwellStartRef = useRef(0);        // when the current good pose began
  const maxSharpRef = useRef(0);          // session-best sharpness (adaptive blur gate)
  // Per-cell list of captured board tilts (deg) — drives orientation diversity:
  // a 2nd/3rd capture in a cell only counts if its tilt is fresh.
  const cellTiltsRef = useRef(Array.from({ length: geometry.totalCells }, () => []));

  // Guided-sequence progress. guidedStepRef indexes GUIDED_STEPS; guidedShotsRef
  // is how many of this step's shots are banked (0..shots); guidedSigRef is the
  // first shot's signature, so the 2nd can be required to differ a little.
  const guidedStepRef = useRef(0);
  const guidedShotsRef = useRef(0);
  const guidedSigRef = useRef(null);
  // Directional-guidance state machine (see steer). Speaks only when it carries
  // new information, and goes quiet while the board is closing in.
  const dirStateRef = useRef({ dir: null, target: null, refDist: Infinity, lastSpeak: 0, arrived: false });

  // Cancellation flag so async snaps don't set state after unmount.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  const resetGuided = useCallback(() => {
    guidedStepRef.current = 0; guidedShotsRef.current = 0; guidedSigRef.current = null;
    setGuidedProgress({ step: 0, shots: 0 });
    dirStateRef.current = { dir: null, target: null, refDist: Infinity, lastSpeak: 0, arrived: false };
  }, []);

  const resetSession = useCallback(() => {
    const total = geomRef.current.totalCells;
    setCounts(new Array(total).fill(0));
    cellTiltsRef.current = Array.from({ length: total }, () => []);
    prevCornersRef.current = null;
    lastDetSeqRef.current = -1;
    dwellStartRef.current = 0;
    maxSharpRef.current = 0;
    resetGuided();
  }, [resetGuided]);

  // A new dataset folder is a new capture session.
  useEffect(() => { resetSession(); }, [datasetPath, resetSession]);
  // Switching capture mode restarts the checklist.
  useEffect(() => { resetGuided(); }, [mode, resetGuided]);

  // Serialise every capture — auto and manual alike — through one lock, so a
  // space-bar snap can never interleave with an auto-snap mid-flight.
  const withSnapLock = useCallback(async (fn) => {
    if (snapInFlightRef.current) return null;
    snapInFlightRef.current = true;
    try { return await fn(); } finally { snapInFlightRef.current = false; }
  }, []);

  // Tally the just-snapped frame into the live coverage. Only cells the board
  // actually filled (≥ CAPTURE_MIN_CORNERS corners) are incremented, so coverage
  // reflects deliberate captures — not the live board sweeping past.
  const markFromManualSnap = useCallback(({ silent = false } = {}) => {
    const meta = latestMetaRef.current;
    const geom = geomRef.current;
    if (!meta?.corners?.length || !geom.extent) return;
    const perCell = geom.bin(meta.corners);
    const b = boardRef.current;
    const tilt = boardTiltDeg(meta.corners, b.cols, b.rows);
    // record this capture's tilt in every cell it covered, for orientation diversity
    if (tilt != null) {
      perCell.forEach((cnt, i) => { if (cnt >= CAPTURE_MIN_CORNERS) cellTiltsRef.current[i].push(tilt); });
    }
    setCounts(prev => {
      const next = prev.map((n, i) => n + (perCell[i] >= CAPTURE_MIN_CORNERS ? 1 : 0));
      // Spoken cues: a short "captured", and "coverage complete" the moment the
      // last cell crosses from empty to covered. Guided mode passes silent:true
      // and drives its own voice cadence (per-step, not per-cell).
      if (!silent) {
        sayRef.current?.('captured', 600);
        const wasFull = prev.every(n => n > 0);
        if (!wasFull && next.every(n => n > 0)) sayRef.current?.('allCovered');
      }
      return next;
    });
  }, []);

  // Advance the guided checklist by one banked shot. Auto-capture advances
  // inline in onMeta; this keeps manual (space-bar) snaps in guided mode in sync
  // so the overlay/HUD step doesn't stall while the user shoots by hand.
  const advanceGuidedShot = useCallback(() => {
    const step = GUIDED_STEPS[guidedStepRef.current];
    if (!step) return;
    const m = analyzeBoard(latestMetaRef.current?.corners, boardRef.current, geomRef.current.extent);
    const newShots = guidedShotsRef.current + 1;
    if (newShots >= step.shots) {
      guidedShotsRef.current = 0; guidedSigRef.current = null; guidedStepRef.current += 1;
      setGuidedProgress({ step: guidedStepRef.current, shots: 0 });
    } else {
      guidedShotsRef.current = newShots; guidedSigRef.current = shotSignature(m);
      setGuidedProgress({ step: guidedStepRef.current, shots: newShots });
    }
  }, []);

  // Decide whether to speak a steering cue this frame. Event-driven: speak on a
  // new target, a changed direction, drifting the wrong way, or a stall — and go
  // quiet while the board is closing in. `key` resets the progress baseline when
  // the thing we're steering toward changes.
  const steer = useCallback((curX, curY, target, key) => {
    const st = dirStateRef.current;
    if (st.target !== key) { st.target = key; st.dir = null; st.refDist = Infinity; }
    if (curX == null || !target) return;
    const geom = geomRef.current;
    const r = geom.extent ? Math.min(geom.extent.rx, geom.extent.ry) : 0;
    if (!r) return;
    const dx = target.x - curX, dy = target.y - curY;
    const dist = Math.hypot(dx, dy);
    let dir = geom.radialCue({ x: curX, y: curY }, target);
    if (!dir) {
      if (Math.abs(dx) > Math.abs(dy)) {
        const right = dx > 0;
        dir = (right !== mirrorRef.current) ? 'moveRight' : 'moveLeft';  // mirror swaps L/R
      } else dir = dy > 0 ? 'moveDown' : 'moveUp';
    }
    const now = performance.now();
    const eps = r * 0.06;
    const progressed = dist <= st.refDist - eps;
    const wrongWay = dist >= st.refDist + eps;
    let speakIt = false;
    if (dir !== st.dir) speakIt = now - st.lastSpeak > 900;        // new direction
    else if (wrongWay) speakIt = now - st.lastSpeak > 1500;        // drifting away
    else if (!progressed) speakIt = now - st.lastSpeak > 3500;     // stalled, no progress
    if (progressed) st.refDist = dist;                            // closing in → stay quiet
    if (speakIt) { sayRef.current?.(dir); st.dir = dir; st.refDist = dist; st.lastSpeak = now; }
  }, []);

  // Sweep-mode steering, which additionally announces arrival on the target cell
  // and only nags once the board is sitting on an already-full cell.
  const steerSweep = useCallback(({ cell, reason, curX, curY }) => {
    const guid = guidanceRef.current;
    const st = dirStateRef.current;
    if (st.target !== guid) { st.target = guid; st.dir = null; st.refDist = Infinity; st.arrived = false; }
    const geom = geomRef.current;
    if (guid == null || !geom.extent || cell == null) return;
    if (cell === guid) {                       // on the target cell
      if (!st.arrived) { st.arrived = true; sayRef.current?.('onTarget'); }
      return;
    }
    st.arrived = false;
    if (reason !== 'enough') return;           // only steer off an already-full cell
    const target = geom.cellCenter(guid);
    if (!target) return;
    steer(curX, curY, target, guid);
  }, [steer]);

  // `doSnap` does ONLY the capture + undo bookkeeping and resolves as soon as
  // the path is known — deliberately narrow, so `after(r)` (the coverage
  // tally, guided-step advance, voice cue and status) runs immediately off
  // that resolution, before the page's dataset-listing round-trip. That's
  // the only ordering this actually guarantees — `api.snap` itself takes on
  // the order of 100ms, during which the live stream can still overwrite
  // `latestMetaRef` more than once — but it avoids adding a further,
  // multi-hundred-millisecond window on top of that. The page's
  // dataset-listing refresh (`onCaptured`) runs only AFTER `after(r)` has
  // already applied — a failure there must not un-tally the capture or
  // revert the status `after(r)` just set, so it's caught separately and
  // reported as its own error rather than autoSnapFailed (the capture did
  // succeed; only the listing refresh didn't).
  const runAutoSnap = useCallback((after) => {
    const now = performance.now();
    lastAutoSnapRef.current = now;
    dwellStartRef.current = 0;
    withSnapLock(async () => {
      let r;
      try {
        r = await doSnapRef.current();
      } catch (e) {
        if (cancelledRef.current) return;
        setStatusRef.current?.(tRef.current('common.autoSnapFailed', { error: e.message }), true);
        return;
      }
      if (cancelledRef.current || !r) return;
      // `after(r)` (tally / guided-step advance / voice cue / status) must run
      // to completion before the listing refresh starts. If it somehow throws,
      // that's still a capture-processing failure, so it's reported the same
      // way a `doSnap` failure is — unlike a listing failure below, which is
      // NOT a capture failure and gets its own message.
      try {
        after(r);
      } catch (e) {
        if (cancelledRef.current) return;
        setStatusRef.current?.(tRef.current('common.autoSnapFailed', { error: e.message }), true);
        return;
      }
      try {
        await onCapturedRef.current?.(r);
      } catch (e) {
        if (cancelledRef.current) return;
        setStatusRef.current?.(tRef.current('common.listingFailed', { error: e.message }), true);
      }
    });
  }, [withSnapLock]);

  const onMeta = useCallback((meta) => {
    // Always stash the freshest meta so a manual snap can bin its corners, even
    // when auto-capture is off.
    latestMetaRef.current = meta;
    const corners = meta?.corners;
    const size = meta?.image_size;
    const geom = geomRef.current;
    const t = tRef.current;

    if (!enabledRef.current || !deviceRef.current || !datasetRef.current) { dwellStartRef.current = 0; return; }
    // The backend streams video faster than it detects, so the same detection
    // arrives on several frames. Run the capture/motion logic only on a FRESH
    // detection, else a moving board's repeated corners read as "still".
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

    const b = boardRef.current;
    const extent = geom.extent;

    // ── Guided-sequence branch ────────────────────────────────────────────────
    // Doc-driven checklist: walk GUIDED_STEPS in order, two shots per action, the
    // 2nd required to differ a little from the 1st. Region + pose are matched
    // against the active step; we steer with voice/HUD until both are satisfied,
    // then dwell-snap. Shares the motion + sharpness gates above.
    if (modeRef.current === 'guided') {
      const debouncedG = now - lastAutoSnapRef.current >= Math.max(400, rateRef.current * 1000);
      const step = GUIDED_STEPS[guidedStepRef.current];
      if (!step) {                                  // whole sequence finished
        dwellStartRef.current = 0;
        setAutoHud({ reason: 'done', dwell: 0, guidedLabel: t('guided.done') });
        return;
      }
      const shots = guidedShotsRef.current;
      const m = analyzeBoard(corners, b, extent);
      const rOk = regionOk(step, m, extent);
      const pOk = poseOk(step, m, profileRef.current);
      const needVary = shots === 1 && !differsEnough(guidedSigRef.current, m, extent);

      let reason;
      if (!rOk) reason = 'region';
      else if (!pOk) reason = 'pose';
      else if (needVary) reason = 'vary';
      else if (!sharpOk) reason = 'blurry';
      else if (!still) reason = 'hold';
      else reason = 'capturing';

      // Voice steering: position first, then pose.
      if (!rOk) {
        steer(m.centroid?.x, m.centroid?.y, regionTarget(step.region, extent), step.id);
      } else if (!pOk) {
        sayRef.current?.('tiltHint', 4000);
      }

      const label = t('guided.progress', {
        step: guidedStepRef.current + 1, total: GUIDED_STEPS.length,
        group: t(`guided.groups.${step.group}`),
        action: t(`guided.steps.${step.id}`),
        shot: shots + 1, shots: step.shots,
      });

      const readyG = rOk && pOk && !needVary && sharpOk && still && debouncedG;
      if (!readyG || snapInFlightRef.current) {
        if (reason !== 'capturing') dwellStartRef.current = 0;
        setAutoHud({ reason, dwell: 0, tilt: m.tilt, guidedLabel: label });
        return;
      }
      if (dwellStartRef.current === 0) dwellStartRef.current = now;
      const heldG = now - dwellStartRef.current;
      setAutoHud({ reason: 'capturing', dwell: Math.min(1, heldG / DWELL_MS), tilt: m.tilt, guidedLabel: label });
      if (heldG < DWELL_MS) return;

      const sigNow = shotSignature(m);
      runAutoSnap((r) => {
        markFromManualSnap({ silent: true });   // feed the fallback coverage % silently
        const newShots = shots + 1;
        if (newShots >= step.shots) {           // step done → advance
          guidedShotsRef.current = 0;
          guidedSigRef.current = null;
          guidedStepRef.current += 1;
          const done = guidedStepRef.current >= GUIDED_STEPS.length;
          sayRef.current?.(done ? 'allCovered' : 'captured', 600);
          setGuidedProgress({ step: guidedStepRef.current, shots: 0 });
        } else {                                 // banked shot 1 → wait for a varied 2nd
          guidedShotsRef.current = newShots;
          guidedSigRef.current = sigNow;
          sayRef.current?.('captured', 600);
          setGuidedProgress({ step: guidedStepRef.current, shots: newShots });
        }
        setStatusRef.current?.(t('common.autoSnapped', {
          name: r.path.split('/').pop(), cell: guidedStepRef.current,
        }));
      });
      return;
    }

    // ── Sweep branch ──────────────────────────────────────────────────────────
    // 3) Novelty (corner-binned, to match the coverage tally): bin THIS board's
    //    corners into cells exactly like markFromManualSnap, instead of keying
    //    only on the cell its centroid sits in. A board pushed to the frame edge
    //    deposits corners into an empty edge cell even while its centroid stays
    //    mid-frame, so corner-in-cell rewards the edge shots that matter most.
    //    The target cell is the emptiest under-sampled cell the board actually
    //    fills (≥ CAPTURE_MIN_CORNERS corners), tie-broken toward the outside
    //    (higher flat index) — the hardest, most valuable ones.
    let sx = 0, sy = 0;
    for (const c of corners) { sx += c[0]; sy += c[1]; }
    const cenX = sx / corners.length, cenY = sy / corners.length;
    const centroidCell = geom.cellAt(cenX, cenY);
    const cnts = countsRef.current;
    const tilt = boardTiltDeg(corners, b.cols, b.rows);
    const perCell = geom.bin(corners);
    let cell = null, cellCount = TARGET_PER_CELL;
    for (let i = 0; i < perCell.length; i++) {
      if (perCell[i] < CAPTURE_MIN_CORNERS) continue;
      const n = cnts[i] ?? 0;
      if (n < TARGET_PER_CELL && (cell == null || n < cellCount || (n === cellCount && i > cell))) {
        cell = i; cellCount = n;
      }
    }
    // Tilt freshness is tracked against the target cell (or the centroid cell
    // when the board adds no new coverage), and judged against the MOST RECENT
    // capture in that cell — not every prior one. Comparing to all past tilts
    // means that once you've swept a range of angles, every new angle lands
    // within TILT_MIN_DIFF of *some* earlier capture and the gate locks up.
    const trackCell = cell != null ? cell : centroidCell;
    const tilts = trackCell != null ? cellTiltsRef.current[trackCell] : [];
    const lastTilt = tilts?.length ? tilts[tilts.length - 1] : null;
    const tiltFresh = tilt == null || lastTilt == null
      || Math.abs(lastTilt - tilt) >= TILT_MIN_DIFF;
    const underTarget = cell != null;     // set only when an under-target cell is filled
    const novel = underTarget && (cellCount === 0 || tiltFresh);

    // 4) Debounce after a snap, and never overlap an in-flight snap.
    const debounced = now - lastAutoSnapRef.current >= Math.max(400, rateRef.current * 1000);

    let reason;
    if (cell == null) reason = 'enough';                   // board adds no under-target coverage
    else if (!tiltFresh) reason = 'tilt';                  // need a different angle here
    else if (!sharpOk) reason = 'blurry';
    else if (!still) reason = 'hold';
    else reason = 'capturing';

    steerSweep({ cell: centroidCell, reason, curX: cenX, curY: cenY });

    const ready = novel && sharpOk && still && debounced;
    if (!ready || snapInFlightRef.current) {
      if (reason !== 'capturing') dwellStartRef.current = 0;
      if (reason === 'tilt') sayRef.current?.('tiltHint', 4000);
      setAutoHud({ reason, dwell: 0, tilt });
      return;
    }

    // 5) Dwell: hold the good pose for DWELL_MS before firing.
    if (dwellStartRef.current === 0) dwellStartRef.current = now;
    const held = now - dwellStartRef.current;
    setAutoHud({ reason: 'capturing', dwell: Math.min(1, held / DWELL_MS), tilt });
    if (held < DWELL_MS) return;

    runAutoSnap((r) => {
      markFromManualSnap();
      setStatusRef.current?.(t('common.autoSnapped', {
        name: r.path.split('/').pop(), cell: cell ?? 0,
      }));
    });
  }, [markFromManualSnap, runAutoSnap, steer, steerSweep]);

  // Turning auto-capture off clears the badge and any half-finished dwell.
  useEffect(() => {
    if (!enabled) { setAutoHud(null); dwellStartRef.current = 0; }
  }, [enabled]);

  return {
    onMeta, autoHud, counts, guidedProgress,
    resetSession, markFromManualSnap, advanceGuidedShot, withSnapLock,
  };
}
