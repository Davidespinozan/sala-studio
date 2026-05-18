import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

interface Props {
  onClose: () => void;
  onScan: (payload: string) => void;
}

export function CameraModal({ onClose, onScan }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const cooldownRef = useRef(0);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    let active = true;

    async function start() {
      try {
        const reader = new BrowserMultiFormatReader();
        readerRef.current = reader;

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
          });
        }

        videoEl!.srcObject = stream;
        await videoEl!.play();

        await reader.decodeFromVideoElement(videoEl!, (result) => {
          if (!active || !result) return;
          const now = Date.now();
          if (now - cooldownRef.current < 1500) return;
          cooldownRef.current = now;
          onScan(result.getText());
        });
      } catch (e) {
        if (!active) return;
        setCameraError(e instanceof Error ? e.message : 'No se pudo acceder a la cámara');
      }
    }

    start();

    return () => {
      active = false;
      try {
        const stream = videoEl?.srcObject as MediaStream | null;
        stream?.getTracks().forEach((t) => t.stop());
      } catch { /* noop */ }
    };
  }, [onScan]);

  return (
    <div className="rec-camera-modal" onClick={onClose}>
      <div className="rec-camera-modal-inner" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="rec-camera-close">✕</button>
        <div className="rec-camera-wrap">
          {cameraError ? (
            <div className="rec-camera-error">
              <p className="ek-h3" style={{ color: 'var(--ek-cream)' }}>Sin cámara</p>
              <p style={{ color: 'rgba(245,241,232,0.7)', fontSize: '0.875rem', marginTop: '0.5rem' }}>
                {cameraError}
              </p>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="rec-video" autoPlay playsInline muted />
              <div className="rec-camera-overlay">
                <div className="rec-scan-frame" />
                <p className="rec-scan-hint">Apuntá al QR</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
