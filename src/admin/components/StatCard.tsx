interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
}

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div className="adm-stat-card">
      <p className="adm-stat-label">{label}</p>
      <p className="adm-stat-value">{value}</p>
      {hint && <p className="adm-stat-hint">{hint}</p>}
    </div>
  );
}
