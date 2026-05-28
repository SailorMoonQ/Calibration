import { useEffect, useRef } from 'react';
import { posesWsUrl } from '../api/client.js';

export const initialSlot = (overrides = {}) => ({
  mode: 'live',                 // 'live' | 'import'
  // live mode
  backend: 'steamvr',           // 'oculus' | 'pico' | 'steamvr'
  adbIp: '',
  fps: 30,
  connected: false,
  recording: false,
  recordedPath: null,
  recCount: 0,
  // import mode
  format: 'json',               // 'json' | 'yaml' | 'mcap'
  filePath: null,
  mcapTopics: [],
  mcapTopic: null,
  importedPath: null,
  importMeta: null,
  // shared
  devices: [],
  device: null,
  vizSamples: [],               // for trajectory rendering (live tail or imported full)
  liveCurT: null,
  ...overrides,
});

export function slotReady(s) {
  if (!s.device) return false;
  if (s.mode === 'live') return Boolean(s.recordedPath);
  return Boolean(s.importedPath);
}

// Returns the canonical recording-JSON path for a ready slot, or null.
export function slotPath(s) {
  if (!slotReady(s)) return null;
  return s.mode === 'live' ? s.recordedPath : s.importedPath;
}

/**
 * Per-slot WebSocket lifecycle. Opens when slot.mode === 'live' && wantConnected,
 * closes otherwise. Pushes hello.devices into the slot, and forwards sample/error
 * messages to the caller.
 *
 * Returns { wsRef, ticksRef, recordingActiveRef }.
 */
export function useSlotWs({ slot, setSlot, wantConnected, setWantConnected, onHello, onSample, onError }) {
  const wsRef = useRef(null);
  const ticksRef = useRef({});       // { device: [{ts, present}] } — reset on every `hello` to match the new device list
  const recordingActiveRef = useRef(false);

  // Latest-ref pattern: keep callback refs current so the long-lived WS handlers
  // never see stale closures when the parent re-renders with new function identities.
  const onHelloRef = useRef(onHello);
  const onSampleRef = useRef(onSample);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onHelloRef.current = onHello;
    onSampleRef.current = onSample;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (slot.mode !== 'live' || !wantConnected) {
      if (wsRef.current) { try { wsRef.current.close(); } catch { /* swallow */ } wsRef.current = null; }
      // The previous run's onclose bails on `cancelled`, so reset connect state here.
      setSlot(s => (s.connected || s.recording) ? { ...s, connected: false, recording: false } : s);
      recordingActiveRef.current = false;
      return;
    }
    let cancelled = false;
    let localWs = null;
    (async () => {
      try {
        const url = await posesWsUrl({
          fps: slot.fps,
          sources: [slot.backend],
          ip: slot.backend === 'oculus' && slot.adbIp ? slot.adbIp : undefined,
        });
        if (cancelled) return;
        const ws = new WebSocket(url);
        localWs = ws;
        wsRef.current = ws;
        ws.onopen = () => { if (!cancelled) setSlot(s => ({ ...s, connected: true })); };
        ws.onclose = () => {
          if (cancelled) return;  // cleanup already fired; ignore the deferred close
          setSlot(s => ({ ...s, connected: false, recording: false }));
          recordingActiveRef.current = false;
          wsRef.current = null;
          // Reset connect-intent so the next click re-triggers the effect.
          // Without this, wantConnected stays true after a server-side close
          // (e.g. SteamVR init failure) and React bails out of setWantConnected(true).
          setWantConnected?.(false);
        };
        ws.onerror = () => onErrorRef.current?.('ws error');
        ws.onmessage = (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.type === 'hello') {
            const devices = Array.isArray(m.devices) ? m.devices : [];
            setSlot(s => ({
              ...s,
              devices,
              device: s.device && devices.includes(s.device) ? s.device : (devices[0] ?? null),
            }));
            ticksRef.current = Object.fromEntries(devices.map(d => [d, []]));
            onHelloRef.current?.(m);
            return;
          }
          if (m.type === 'error') { onErrorRef.current?.(`${m.source}: ${m.message}`); return; }
          if (m.type !== 'sample') return;
          onSampleRef.current?.(m);
        };
      } catch (e) {
        if (!cancelled) onErrorRef.current?.(`connect failed: ${e.message}`);
      }
    })();
    return () => {
      cancelled = true;
      if (localWs) { try { localWs.close(); } catch { /* swallow */ } }
      if (wsRef.current === localWs) wsRef.current = null;
    };
    // Connect-relevant slot fields only — callbacks are accessed via refs above
    // so they don't need to retrigger reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.mode, slot.backend, slot.adbIp, slot.fps, wantConnected]);

  return { wsRef, ticksRef, recordingActiveRef };
}
