import { useCallback, useEffect, useRef } from 'react';
import { posesWsUrl } from '../api/client.js';

export const initialSlot = (overrides = {}) => ({
  mode: 'live',                 // 'live' | 'import'
  // live mode
  backend: 'mock',              // 'mock' | 'oculus' | 'steamvr'
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
export function useSlotWs({ slot, setSlot, wantConnected, onHello, onSample, onError }) {
  const wsRef = useRef(null);
  const ticksRef = useRef({});       // { device: [{ts, present}] }
  const recordingActiveRef = useRef(false);

  const close = useCallback(() => {
    if (wsRef.current) { try { wsRef.current.close(); } catch { /* swallow */ } }
    wsRef.current = null;
  }, []);

  useEffect(() => {
    if (slot.mode !== 'live' || !wantConnected) {
      close();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = await posesWsUrl({
          fps: slot.fps,
          sources: [slot.backend],
          ip: slot.backend === 'oculus' && slot.adbIp ? slot.adbIp : undefined,
        });
        if (cancelled) return;
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => setSlot(s => ({ ...s, connected: true }));
        ws.onclose = () => {
          setSlot(s => ({ ...s, connected: false, recording: false }));
          recordingActiveRef.current = false;
          wsRef.current = null;
        };
        ws.onerror = () => onError?.('ws error');
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
            onHello?.(m);
            return;
          }
          if (m.type === 'error') { onError?.(`${m.source}: ${m.message}`); return; }
          if (m.type !== 'sample') return;
          onSample?.(m);
        };
      } catch (e) {
        onError?.(`connect failed: ${e.message}`);
      }
    })();
    return () => { cancelled = true; close(); };
    // We deliberately depend on the connect-relevant slot fields only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.mode, slot.backend, slot.adbIp, slot.fps, wantConnected]);

  return { wsRef, ticksRef, recordingActiveRef };
}
