interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  description?: string;
}

export default function Toggle({ checked, onChange, label, description }: ToggleProps) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        cursor: 'pointer',
        userSelect: 'none'
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          flexShrink: 0,
          width: '44px',
          height: '26px',
          borderRadius: '13px',
          background: checked ? 'var(--ek-mustard)' : 'var(--ek-bg-elevated)',
          border: `0.5px solid ${checked ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
          position: 'relative',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          padding: 0
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: '2px',
            left: checked ? '20px' : '2px',
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            background: checked ? 'var(--ek-bg)' : 'var(--ek-ink-muted)',
            transition: 'left 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
          }}
        />
      </button>

      {(label || description) && (
        <div style={{ flex: 1 }}>
          {label && (
            <p style={{ fontSize: '14px', fontWeight: 500, margin: 0, color: 'var(--ek-ink)' }}>
              {label}
            </p>
          )}
          {description && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '2px 0 0 0' }}>
              {description}
            </p>
          )}
        </div>
      )}
    </label>
  );
}
