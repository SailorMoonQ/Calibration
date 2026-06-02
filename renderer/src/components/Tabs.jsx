import { useTranslation } from 'react-i18next';

export function Tabs({ tabs, value, onChange }) {
  const { t } = useTranslation();
  return (
    <div className="tabs">
      {tabs.map(tab => (
        <button key={tab.id}
          className={"tab" + (value === tab.id ? ' active' : '')}
          onClick={() => onChange(tab.id)}>
          <span className="tnum">{tab.num}</span>
          <span>{tab.label}<span style={{color: 'var(--text-4)', fontWeight: 400}}> · {tab.sub}</span></span>
          <span className={"badge " + tab.badge}>{tab.badge === 'ok' ? '✓' : tab.badge === 'warn' ? '!' : '×'}</span>
        </button>
      ))}
      <span style={{ flex: 1 }}/>
      <button className="tab" style={{ color: 'var(--text-3)', fontSize: 11.5 }}>{t('tabs.addStage')}</button>
    </div>
  );
}
