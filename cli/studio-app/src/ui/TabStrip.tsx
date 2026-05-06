interface Tab<T extends string> {
  id: T;
  label: string;
  count?: number;
}

interface TabStripProps<T extends string> {
  tabs: Tab<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function TabStrip<T extends string>({ tabs, value, onChange }: TabStripProps<T>) {
  return (
    <div className="ad-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`ad-tab${value === t.id ? " ad-tab--active" : ""}`}
        >
          <span>{t.label}</span>
          {t.count != null && <span className="ad-tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
