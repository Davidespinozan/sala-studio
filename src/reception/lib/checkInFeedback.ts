// Feedback de mostrador para check-in: beep (Web Audio) + vibración.
// Default-on, sin preferencia. Todo degrada a no-op si el browser no soporta
// AudioContext (Safari viejo), navigator.vibrate (iOS Safari) o si todavía no
// hubo user-gesture (autoplay policy) — nunca tira error.

// AudioContext perezoso y reutilizado (crear uno por beep agota los slots).
let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) audioCtx = new Ctor();
    return audioCtx;
  } catch {
    return null;
  }
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // navigator.vibrate ausente o bloqueado → no-op
  }
}

/**
 * Un tono con envolvente suave (fade in/out) para que no "clickee".
 * Se agenda sobre el reloj del AudioContext (startTime en segundos).
 */
function tone(ctx: AudioContext, freq: number, startTime: number, durationSec: number, peak = 0.18): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;

  const attack = 0.015;
  const release = 0.04;
  const sustainEnd = startTime + Math.max(attack, durationSec - release);

  // exponentialRamp no puede arrancar/terminar en 0 → usamos ~0.0001.
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peak, startTime + attack);
  gain.gain.setValueAtTime(peak, sustainEnd);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

  osc.connect(gain).connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + durationSec + 0.02);
}

/** Check-in OK: beep agudo (~800Hz, 150ms) + vibración corta. */
export function playCheckInSuccess(): void {
  const ctx = getCtx();
  if (ctx) {
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      tone(ctx, 800, ctx.currentTime, 0.15);
    } catch {
      // autoplay policy / contexto inválido → silencioso
    }
  }
  vibrate(50);
}

/** Check-in rechazado: beep grave (~200Hz) en dos pulsos + vibración doble. */
export function playCheckInError(): void {
  const ctx = getCtx();
  if (ctx) {
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      const t = ctx.currentTime;
      tone(ctx, 200, t, 0.13);
      tone(ctx, 200, t + 0.19, 0.13);
    } catch {
      // autoplay policy / contexto inválido → silencioso
    }
  }
  vibrate([100, 50, 100]);
}
