import { useEffect, useState } from 'react';
import { Download, Upload, X } from 'lucide-react';

/**
 * Banner sticky-bottom que invita al socio a instalar la app como PWA.
 *
 * Solo se muestra cuando TODOS los gates pasan, en este orden:
 *   1. NO es contenedor Capacitor (futuro app nativa).
 *   2. NO está ya instalada (display-mode standalone / navigator.standalone).
 *   3. ES móvil (iOS Safari, iOS Chrome o Android). Desktop fuera de scope.
 *   4. NO fue descartada en los últimos 90 días.
 *   5. Aparece con DELAY de 4 segundos post-montaje (no apenas el auth).
 *
 * Por plataforma:
 *   - Android (Chromium): captura beforeinstallprompt (con preventDefault para
 *     ocultar la mini-infobar de Chrome). Botón "Instalar" → event.prompt()
 *     → escucha userChoice (accepted | dismissed).
 *   - iOS Safari: instrucción inline "Toca el botón de compartir ⬆️ en Safari
 *     y elige 'Agregar a inicio'" — con ícono <Upload> de lucide-react que
 *     replica visualmente el botón nativo (cuadrado abierto + flecha arriba).
 *     No hay API para gatillar el flujo desde JS en WebKit.
 *   - iOS Chrome (UA contiene "CriOS"): Apple no permite instalación PWA
 *     desde WebView/Chrome iOS. Mensaje guía: "Para instalar la app, abre
 *     esta página en Safari" (sin ícono, sin botón funcional, solo ✕).
 *
 * Textos en tuteo MEXICANO (mercado objetivo: Culiacán, MX). Para resto de
 * la app sigue habiendo voseo rioplatense — ver D-020.
 *
 * Persistencia: localStorage `sala-pwa-install-dismissed-at` (timestamp ISO),
 * mismo patrón con try/catch que `src/admin/components/Sidebar.tsx`.
 *
 * Trade-off conocido (D-018): el ícono y nombre que se instalan son los de
 * SALA, no los del tenant — requiere manifest dinámico por subdominio. El
 * banner solo invita; la pieza de identidad la resuelve D-018.
 */

const DISMISSED_KEY = 'sala-pwa-install-dismissed-at';
const RESHOW_DAYS = 90;
const APPEAR_DELAY_MS = 4000;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

type Platform = 'ios-safari' | 'ios-chrome' | 'android' | 'other';

function isNativeCapacitor(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform() === true;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  if ((window.navigator as unknown as { standalone?: boolean }).standalone === true) {
    return true;
  }
  return false;
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'other';
  const ua = navigator.userAgent;
  const winMS = (window as unknown as { MSStream?: unknown }).MSStream;
  if (/iPad|iPhone|iPod/.test(ua) && !winMS) {
    // Chrome iOS se identifica con "CriOS" en el UA. Apple no permite
    // instalación PWA fuera de Safari, así que el branch muestra un
    // mensaje guía distinto ("abre en Safari").
    return /CriOS/.test(ua) ? 'ios-chrome' : 'ios-safari';
  }
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

function readDismissedAt(): Date | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function writeDismissedAt(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
  } catch {
    // ignore quota / private mode
  }
}

function dismissedRecently(): boolean {
  const d = readDismissedAt();
  if (!d) return false;
  return Date.now() - d.getTime() < RESHOW_DAYS * 24 * 60 * 60 * 1000;
}

export function PwaInstallBanner({ appNombre }: { appNombre?: string } = {}) {
  const [visible, setVisible] = useState(false);
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [platform, setPlatform] = useState<Platform>('other');

  // Gate + setup. Corre una sola vez al montar.
  useEffect(() => {
    if (isNativeCapacitor()) return;
    if (isStandalone()) return;
    if (dismissedRecently()) return;

    const p = detectPlatform();
    if (p === 'other') return;
    setPlatform(p);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (p === 'ios-safari' || p === 'ios-chrome') {
      // iOS no expone API de instalación: mostramos texto tras delay.
      // ios-safari → instrucción de "compartir + Agregar a inicio".
      // ios-chrome → instrucción de "abrir en Safari" (Apple no permite
      // instalación PWA desde Chrome iOS).
      timer = setTimeout(() => {
        if (!cancelled) setVisible(true);
      }, APPEAR_DELAY_MS);
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }

    // Android Chromium: esperamos beforeinstallprompt, luego delay.
    const handler = (e: Event) => {
      e.preventDefault(); // oculta la mini-infobar nativa de Chrome
      if (cancelled) return;
      setPromptEvent(e as BeforeInstallPromptEvent);
      timer = setTimeout(() => {
        if (!cancelled) setVisible(true);
      }, APPEAR_DELAY_MS);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('beforeinstallprompt', handler);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Si el usuario instala desde otro path (eg. menú nativo del navegador),
  // ocultar inmediatamente.
  useEffect(() => {
    const onInstalled = () => setVisible(false);
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  if (!visible) return null;

  const handleDismiss = () => {
    writeDismissedAt();
    setVisible(false);
  };

  const handleInstall = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'dismissed') writeDismissedAt();
    // Si aceptó: el evento 'appinstalled' va a disparar y ocultar igual.
    setPromptEvent(null);
    setVisible(false);
  };

  return (
    <div
      role="region"
      aria-label="Instalar aplicación"
      style={{
        position: 'fixed',
        bottom: '96px',
        left: '12px',
        right: '12px',
        marginInline: 'auto',
        maxWidth: '480px',
        background: 'var(--sala-surface)',
        border: '0.5px solid var(--ek-line)',
        borderRadius: '14px',
        boxShadow: 'var(--ek-shadow-md)',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        zIndex: 60
      }}
    >
      {/* Insignia en el color primario del tenant: es lo que le da "su marca"
          al banner (el resto de la tarjeta es neutro para no pelearse con el
          fondo claro/oscuro). */}
      <div
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: '40px',
          height: '40px',
          borderRadius: '10px',
          background: 'var(--grad-primary, var(--sala-primary))',
          color: 'var(--sala-text-on-primary, #fff)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Download size={20} strokeWidth={2.25} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--ek-ink)',
            margin: 0,
            marginBottom: '4px',
            letterSpacing: '-0.01em'
          }}
        >
          {appNombre ? `Instala la app de ${appNombre}` : 'Instala la app'}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0, lineHeight: 1.4 }}>
          {platform === 'ios-safari' && (
            <>
              Toca el botón de compartir{' '}
              <Upload
                size={14}
                aria-hidden="true"
                style={{ display: 'inline-block', verticalAlign: '-3px' }}
              />
              {' '}en Safari y elige "Agregar a inicio".
            </>
          )}
          {platform === 'ios-chrome' && (
            <>Para instalar la app, abre esta página en Safari.</>
          )}
          {platform === 'android' && (
            <>Acceso directo desde tu pantalla de inicio.</>
          )}
        </p>
      </div>

      {platform === 'android' && promptEvent && (
        <button
          type="button"
          onClick={handleInstall}
          className="ek-cta"
          style={{ padding: '8px 14px', fontSize: '13px', whiteSpace: 'nowrap' }}
        >
          Instalar
        </button>
      )}

      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Descartar"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--ek-ink-muted)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          padding: '4px 6px',
          lineHeight: 1,
          flexShrink: 0
        }}
      >
        <X size={18} strokeWidth={2.25} />
      </button>
    </div>
  );
}
