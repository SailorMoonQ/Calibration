import React, { useState, useEffect, useCallback } from 'react';
import { Section, Seg, Field } from './primitives.jsx';
import { Ros2TopicPicker } from './Ros2TopicPicker.jsx';
import { SizeInput } from './SizeInput.jsx';
import { api } from '../api/client.js';

// Owns sourceMode/liveDevice/ros2Topic plus driver-side data (devices,
// streamInfo, availableResolutions). pollEnabled gates the 2 s streamInfo
// poll: when the parent is inspecting saved frames we keep the last info on
// screen but stop pinging the source manager so the camera can rest.
export function useCameraSource({ pollEnabled = true } = {}) {
  const [sourceMode, setSourceMode] = useState('live'); // 'live' | 'ros2'
  const [ros2Topic, setRos2Topic] = useState('');
  const [devices, setDevices] = useState([]);
  const [liveDevice, setLiveDevice] = useState('');
  const [streamInfo, setStreamInfo] = useState(null);
  const [availableResolutions, setAvailableResolutions] = useState([]);

  const rescanDevices = useCallback(() => {
    return api.listStreamDevices()
      .then(r => { setDevices(r.cameras || []); return r; })
      .catch(() => ({ cameras: [] }));
  }, []);

  // Initial device enumeration; auto-pick the first device if the parent
  // hasn't already chosen one.
  useEffect(() => {
    let cancelled = false;
    api.listStreamDevices().then(r => {
      if (cancelled) return;
      const list = r.cameras || [];
      setDevices(list);
      setLiveDevice(prev => prev || list[0]?.device || '');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Driver-advertised modes for the picked device. ros2 sources return [] from
  // the backend; USB cameras return whatever v4l2-ctl enumerates.
  useEffect(() => {
    if (!liveDevice) { setAvailableResolutions([]); return; }
    let cancelled = false;
    api.listStreamResolutions(liveDevice)
      .then(r => { if (!cancelled) setAvailableResolutions(r.resolutions || []); })
      .catch(() => { if (!cancelled) setAvailableResolutions([]); });
    return () => { cancelled = true; };
  }, [liveDevice]);

  useEffect(() => {
    if (!liveDevice) { setStreamInfo(null); return; }
    if (!pollEnabled) return;
    let cancelled = false;
    let timer = null;
    const tick = () => {
      api.streamInfo(liveDevice)
        .then(r => { if (!cancelled) setStreamInfo(r); })
        .catch(() => { if (!cancelled) setStreamInfo(null); })
        .finally(() => { if (!cancelled) timer = setTimeout(tick, 2000); });
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [liveDevice, pollEnabled]);

  return {
    sourceMode, setSourceMode,
    devices, liveDevice, setLiveDevice,
    ros2Topic, setRos2Topic,
    streamInfo, setStreamInfo,
    availableResolutions,
    rescanDevices,
  };
}

export function CameraSourcePanel({ source, onLivePreview }) {
  const {
    sourceMode, setSourceMode,
    devices, liveDevice, setLiveDevice,
    ros2Topic, setRos2Topic,
    streamInfo, setStreamInfo,
    availableResolutions,
    rescanDevices,
  } = source;

  const onModeChange = (v) => {
    setSourceMode(v);
    setLiveDevice('');
    setRos2Topic('');
  };

  return (
    <Section
      title="Source"
      hint={sourceMode === 'live'
        ? (streamInfo?.open
            ? `${streamInfo.width}×${streamInfo.height} · ${streamInfo.capture_fps?.toFixed(1) ?? '—'} fps`
            : (liveDevice || 'no device'))
        : (ros2Topic || 'no topic')
      }
      right={<Seg value={sourceMode} onChange={onModeChange} options={[
        { value: 'live', label: 'live' },
        { value: 'ros2', label: 'ros2' },
      ]}/>}
    >
      {sourceMode === 'live' ? (
        <>
          <Field label="device">
            <select className="select" value={liveDevice} onChange={e => setLiveDevice(e.target.value)}>
              <option value="">— none —</option>
              {devices.map(d => <option key={d.device} value={d.device}>{d.label}</option>)}
            </select>
          </Field>
          {streamInfo?.open && (
            <div className="mono" style={{ fontSize: 11, color:'var(--text-3)', display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2, alignItems:'center' }}>
              <span>resolution</span>
              <SizeInput
                value={[streamInfo.raw_width || streamInfo.width, streamInfo.raw_height || streamInfo.height]}
                options={availableResolutions}
                listId={`resopts-${liveDevice}`}
                title="press Enter to apply — camera restarts at the new size"
                onCommit={(w, h) => api.setStreamResolution(liveDevice, w, h).then(setStreamInfo)}
              />
              <span>clip</span>
              <SizeInput
                value={(streamInfo.clip_width && streamInfo.clip_height)
                  ? [streamInfo.clip_width, streamInfo.clip_height]
                  : null}
                allowOff
                title='post-grab clip target — type "off" to disable, WxH to enable'
                onCommit={(w, h) => api.setStreamClip(liveDevice, w, h).then(setStreamInfo)}
              />
              {streamInfo.clipped && (
                <>
                  <span>effective</span>
                  <span style={{ color:'var(--text-3)' }}>
                    {streamInfo.width} × {streamInfo.height}
                    <span style={{ color:'var(--warn)', marginLeft: 6 }}>· clipped</span>
                  </span>
                </>
              )}
              <span>fps (measured)</span><span style={{ color:'var(--text-1)' }}>{streamInfo.capture_fps?.toFixed(2) ?? '—'}</span>
              <span>fps (advertised)</span><span style={{ color:'var(--text-1)' }}>{streamInfo.fps_advertised?.toFixed(0) ?? '—'}</span>
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
            <button className="btn" onClick={onLivePreview}>👁 live preview</button>
            <button className="btn ghost" onClick={rescanDevices}>↻ rescan</button>
          </div>
        </>
      ) : (
        <>
          <Ros2TopicPicker
            topic={ros2Topic}
            onTopic={(t) => { setRos2Topic(t); setLiveDevice(t ? 'ros2:' + t : ''); }}/>
          {streamInfo?.open && (
            <div className="mono" style={{ fontSize: 11, color:'var(--text-3)', display:'grid', gridTemplateColumns:'auto 1fr', columnGap: 8, rowGap: 2 }}>
              <span>resolution</span><span style={{ color:'var(--text-1)' }}>{streamInfo.width} × {streamInfo.height}</span>
              <span>fps (measured)</span><span style={{ color:'var(--text-1)' }}>{streamInfo.capture_fps?.toFixed(2) ?? '—'}</span>
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
            <button className="btn" onClick={onLivePreview}>👁 live preview</button>
            <div/>
          </div>
        </>
      )}
    </Section>
  );
}
