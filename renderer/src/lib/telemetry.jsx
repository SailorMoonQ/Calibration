import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// Update throttle for writer hooks. Each hook coalesces incoming reports
// to at most one state update every THROTTLE_MS so the topbar doesn't
// re-render on every camera frame.
const THROTTLE_MS = 500;

// Entries older than STALE_MS are dropped by the janitor — backstop for
// tabs that fail to clean up on unmount (errors, dropped WS without close).
const STALE_MS = 3000;

// Janitor sweep interval.
const JANITOR_MS = 1000;

const TelemetryCtx = createContext(null);

export function TelemetryProvider({ children }) {
  // cameras: { [device]: { fps, target, ts } }
  // poses:   { source: string[], bases: number, perDevice: { [name]: { dropPct, ts } }, ts } | null
  const [cameras, setCameras] = useState({});
  const [poses, setPoses] = useState(null);

  // Mutable mirror of `cameras` so reportCamera's throttle check doesn't
  // re-bind the callback on every state change.
  const camerasRef = useRef(cameras);
  useEffect(() => { camerasRef.current = cameras; }, [cameras]);

  const reportCamera = useCallback((device, fps, target) => {
    if (!device) return;
    const prev = camerasRef.current[device];
    const now = performance.now();
    if (prev && now - prev.ts < THROTTLE_MS && prev.fps === fps && prev.target === target) return;
    setCameras(c => ({ ...c, [device]: { fps, target, ts: now } }));
  }, []);

  const clearCamera = useCallback((device) => {
    if (!device) return;
    setCameras(c => {
      if (!(device in c)) return c;
      const { [device]: _gone, ...rest } = c;
      return rest;
    });
  }, []);

  const reportPoses = useCallback((stats) => {
    if (stats == null) { setPoses(null); return; }
    setPoses({ ...stats, ts: performance.now() });
  }, []);

  // Janitor: drop stale entries. Runs at JANITOR_MS, so worst-case staleness
  // before clear is STALE_MS + JANITOR_MS.
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = performance.now() - STALE_MS;
      setCameras(c => {
        let changed = false;
        const next = {};
        for (const [k, v] of Object.entries(c)) {
          if (v.ts >= cutoff) next[k] = v;
          else changed = true;
        }
        return changed ? next : c;
      });
      setPoses(p => (p && p.ts < cutoff ? null : p));
    }, JANITOR_MS);
    return () => clearInterval(id);
  }, []);

  const value = { cameras, poses, reportCamera, clearCamera, reportPoses };
  return <TelemetryCtx.Provider value={value}>{children}</TelemetryCtx.Provider>;
}

export function useTelemetry() {
  const ctx = useContext(TelemetryCtx);
  if (!ctx) throw new Error('useTelemetry must be used inside <TelemetryProvider>');
  return ctx;
}

// Push a camera's current capture FPS into the context. Pass `fps == null`
// to leave the entry untouched (e.g. while the stream is still warming up);
// the entry is automatically cleared on unmount.
export function useReportCamera(device, fps, target) {
  const { reportCamera, clearCamera } = useTelemetry();
  useEffect(() => {
    if (device && fps != null && Number.isFinite(fps)) {
      reportCamera(device, fps, target);
    }
  }, [device, fps, target, reportCamera]);
  useEffect(() => {
    if (!device) return;
    return () => clearCamera(device);
  }, [device, clearCamera]);
}

// Push the latest pose-stream stats. Pass `null` to clear (e.g. on WS close).
export function useReportPoses(stats) {
  const { reportPoses } = useTelemetry();
  useEffect(() => {
    reportPoses(stats);
  }, [stats, reportPoses]);
  useEffect(() => () => reportPoses(null), [reportPoses]);
}
