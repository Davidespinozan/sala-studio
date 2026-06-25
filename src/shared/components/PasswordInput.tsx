import { useState, type CSSProperties } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Input de contraseña con botón de mostrar/ocultar (ojito). Reemplaza los
 * <input type="password"> sueltos para que el usuario pueda ver lo que escribe.
 */
export function PasswordInput({
  value,
  onChange,
  autoComplete = 'current-password',
  placeholder,
  className = 'ek-input',
  ariaLabel,
  id,
  required,
  minLength,
  disabled,
  style
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  id?: string;
  required?: boolean;
  minLength?: number;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-label={ariaLabel}
        required={required}
        minLength={minLength}
        disabled={disabled}
        className={className}
        style={{ paddingRight: '44px', ...style }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        title={visible ? 'Ocultar' : 'Mostrar'}
        style={{
          position: 'absolute',
          right: '6px',
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--sala-text-tertiary)',
          padding: '6px',
          display: 'flex',
          alignItems: 'center'
        }}
      >
        {visible ? <EyeOff size={18} strokeWidth={2} /> : <Eye size={18} strokeWidth={2} />}
      </button>
    </div>
  );
}
