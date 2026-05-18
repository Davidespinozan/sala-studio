export function LoadingScreen() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--ek-cream)',
        color: 'var(--ek-ink-muted)',
        fontFamily: 'var(--ek-font-sans)',
        fontSize: '0.875rem',
        letterSpacing: '0.04em'
      }}
    >
      Cargando…
    </div>
  );
}
