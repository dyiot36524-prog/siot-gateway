// 카메라 QR 스캐너. BarcodeDetector 우선, 없으면(iOS Safari 등) @zxing/browser 를 지연 로드한다.
import { useEffect, useRef, useState } from 'react';

type ScanState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unavailable' | 'error';

interface Props {
  /** 인식할 때마다 호출. continuous=false 면 첫 인식 후 멈춘다 */
  onDetect(text: string): void;
  continuous?: boolean;
  /** 같은 값 반복 인식 억제(ms) */
  dedupeMs?: number;
  hint?: string;
}

interface DetectorLike {
  detect(src: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
interface DetectorCtor {
  new (opts: { formats: string[] }): DetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

async function nativeDetector(): Promise<DetectorLike | null> {
  const BD = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (!BD) return null;
  try {
    const formats = (await BD.getSupportedFormats?.()) ?? ['qr_code'];
    if (!formats.includes('qr_code')) return null;
    return new BD({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

export function QrScanner({ onDetect, continuous = false, dedupeMs = 4000, hint }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ScanState>('idle');
  const [started, setStarted] = useState(false);
  const cb = useRef(onDetect);
  cb.current = onDetect;

  useEffect(() => {
    if (!started) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let raf: ReturnType<typeof setTimeout> | undefined;
    let zxingStop: (() => void) | null = null;
    const last = { text: '', at: 0 };

    const emit = (text: string) => {
      const now = Date.now();
      if (text === last.text && now - last.at < dedupeMs) return;
      last.text = text;
      last.at = now;
      navigator.vibrate?.(60);
      cb.current(text);
      if (!continuous) stop();
    };

    const stop = () => {
      stopped = true;
      clearTimeout(raf);
      zxingStop?.();
      stream?.getTracks().forEach((t) => t.stop());
      setStarted(false);
      setState('idle');
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
        setState('unavailable');
        return;
      }
      setState('starting');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        const name = (e as { name?: string }).name;
        setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error');
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play().catch(() => undefined);
      setState('scanning');

      const det = await nativeDetector();
      if (det) {
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await det.detect(video);
            const v = codes[0]?.rawValue;
            if (v) emit(v);
          } catch {
            /* 프레임 준비 전 */
          }
          if (!stopped) raf = setTimeout(tick, 200);
        };
        void tick();
      } else {
        const { BrowserQRCodeReader } = await import('@zxing/browser');
        if (stopped) return;
        const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 150 });
        const controls = await reader.decodeFromStream(stream, video, (result) => {
          if (result && !stopped) emit(result.getText());
        });
        zxingStop = () => controls.stop();
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(raf);
      zxingStop?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [started, continuous, dedupeMs]);

  if (!started) {
    return (
      <div className="scanner scanner--idle">
        <button type="button" className="btn btn--primary btn--block" onClick={() => setStarted(true)}>
          카메라로 스캔
        </button>
        <p className="muted small">처음 한 번 카메라 권한을 묻습니다. "허용"을 누르세요.</p>
      </div>
    );
  }

  return (
    <div className="scanner">
      <div className="scanner__frame">
        <video ref={videoRef} muted playsInline aria-label="카메라 미리보기" />
        <div className="scanner__guide" aria-hidden />
      </div>
      {state === 'scanning' && <p className="small">{hint ?? 'QR 코드를 네모 안에 맞추세요.'}</p>}
      {state === 'starting' && <p className="small muted">카메라 켜는 중…</p>}
      {state === 'denied' && (
        <div className="notice notice--warn" role="alert">
          <strong>카메라 권한이 막혀 있습니다.</strong>
          <ul>
            <li>아이폰: 설정 › Safari › 카메라 › 허용</li>
            <li>안드로이드: 주소창 왼쪽 자물쇠 › 권한 › 카메라 허용</li>
          </ul>
          허용한 뒤 다시 누르거나, 아래 수동 입력을 쓰세요.
        </div>
      )}
      {state === 'unavailable' && (
        <div className="notice notice--warn" role="alert">
          이 브라우저에서는 카메라를 쓸 수 없습니다(HTTPS 필요). 아래 수동 입력을 쓰세요.
        </div>
      )}
      {state === 'error' && (
        <div className="notice notice--warn" role="alert">
          카메라를 켜지 못했습니다. 다른 앱이 카메라를 쓰는지 확인하세요.
        </div>
      )}
      <button type="button" className="btn btn--ghost btn--block" onClick={() => setStarted(false)}>
        카메라 끄기
      </button>
    </div>
  );
}
