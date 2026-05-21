/** Shell centrado para las pantallas de auth (recuperar / nueva contraseña).
 *  Mismo look que el login: logo SALA + card. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 20px'
      }}
    >
      <div style={{ maxWidth: '400px', width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '36px',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              color: 'var(--ek-mustard)',
              margin: 0
            }}
          >
            SALA
          </h1>
          <p className="ek-eyebrow" style={{ marginTop: '6px' }}>STUDIO</p>
        </div>
        <div className="ek-card">{children}</div>
      </div>
    </div>
  );
}
