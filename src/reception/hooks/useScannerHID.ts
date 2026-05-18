import { useEffect, useRef } from 'react';

/**
 * Listener global de keyboard events para detectar input de scanner USB/HID.
 *
 * Los scanners de QR USB emulan un teclado: escanean → escriben el contenido
 * caracter por caracter muy rápido → terminan con Enter.
 *
 * Heurística:
 *   - El input total tarda <50ms para >15 caracteres
 *   - Termina con la tecla Enter
 *   - Si el tipeo es lento (como un humano), se descarta
 *
 * @param onScan Callback con el payload escaneado
 * @param enabled Si false, no escucha (para pausar mientras hay modales abiertos)
 */
export function useScannerHID(onScan: (payload: string) => void, enabled = true) {
  const bufferRef = useRef<string>('');
  const firstKeyTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    function handleKey(e: KeyboardEvent) {
      // Ignorar si el foco está en un input/textarea (no es scanner, es tipeo humano)
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') {
        return;
      }

      const now = Date.now();

      if (e.key === 'Enter') {
        const buffer = bufferRef.current;
        const elapsed = now - firstKeyTimeRef.current;

        // Validar que parezca scanner: >15 chars en <500ms
        if (buffer.length >= 15 && elapsed < 500) {
          e.preventDefault();
          onScan(buffer);
        }

        bufferRef.current = '';
        firstKeyTimeRef.current = 0;
        return;
      }

      // Solo caracteres imprimibles
      if (e.key.length === 1) {
        if (bufferRef.current === '') {
          firstKeyTimeRef.current = now;
        }
        bufferRef.current += e.key;
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [onScan, enabled]);
}
