import React, { useState, useEffect, useCallback } from 'react';
import { Field } from './primitives.jsx';
import { api } from '../api/client.js';

export function Ros2TopicPicker({ topic, onTopic }) {
  const [topics, setTopics] = useState([]);
  const [manual, setManual] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchTopics = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listRos2Topics();
      setTopics(r.topics || []);
    } catch (e) {
      setErr(e?.message || String(e));
      setTopics([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTopics(); }, [fetchTopics]);

  const onUseManual = () => {
    const t = manual.trim();
    if (t) onTopic(t);
  };

  return (
    <>
      <Field label="topic">
        <select className="select" value={topic}
                onChange={e => onTopic(e.target.value)}>
          <option value="">— none —</option>
          {topics.map(t => (
            <option key={t.topic} value={t.topic}>
              {t.topic} ({t.n_publishers})
            </option>
          ))}
        </select>
      </Field>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
        <button className="btn ghost" onClick={fetchTopics} disabled={loading}>
          ↻ {loading ? 'scanning…' : 'rescan'}
        </button>
        <div/>
      </div>
      {err && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--err)', marginTop: 2 }}>
          {/rclpy unavailable/.test(err)
            ? 'rclpy unavailable — source ROS2 setup before launching backend'
            : err}
        </div>
      )}
      {!err && topics.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>
          no CompressedImage topics found · use manual entry below
        </div>
      )}
      <Field label="manual">
        <div style={{ display:'flex', gap: 6, width: '100%' }}>
          <input className="input" style={{ flex: 1 }} value={manual}
                 placeholder="/camera/image_raw/compressed"
                 onChange={e => setManual(e.target.value)}/>
          <button className="btn" onClick={onUseManual} disabled={!manual.trim()}>use</button>
        </div>
      </Field>
    </>
  );
}
