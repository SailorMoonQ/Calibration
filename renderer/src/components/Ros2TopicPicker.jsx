import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from './primitives.jsx';
import { api } from '../api/client.js';

export function Ros2TopicPicker({ topic, onTopic }) {
  const { t } = useTranslation();
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
      <Field label={t('ros2.topic')}>
        <select className="select" value={topic}
                onChange={e => onTopic(e.target.value)}>
          <option value="">{t('common.none')}</option>
          {topics.map(tp => (
            <option key={tp.topic} value={tp.topic}>
              {tp.topic} ({tp.n_publishers})
            </option>
          ))}
        </select>
      </Field>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
        <button className="btn ghost" onClick={fetchTopics} disabled={loading}>
          ↻ {loading ? t('ros2.scanning') : t('ros2.rescan')}
        </button>
        <div/>
      </div>
      {err && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--err)', marginTop: 2 }}>
          {/rclpy unavailable/.test(err)
            ? t('ros2.rclpyUnavailable')
            : err}
        </div>
      )}
      {!err && topics.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>
          {t('ros2.noTopics')}
        </div>
      )}
      <Field label={t('ros2.manual')}>
        <div style={{ display:'flex', gap: 6, width: '100%' }}>
          <input className="input" style={{ flex: 1 }} value={manual}
                 placeholder={t('ros2.manualPlaceholder')}
                 onChange={e => setManual(e.target.value)}/>
          <button className="btn" onClick={onUseManual} disabled={!manual.trim()}>{t('ros2.use')}</button>
        </div>
      </Field>
    </>
  );
}
