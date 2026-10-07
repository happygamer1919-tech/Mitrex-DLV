"use client";

// In-app camera (DLV-032). The picture is taken INSIDE the app with the MediaDevices API: live preview, a big Take
// photo button, then Use this photo or Retake. The frame is downscaled on a canvas to at most 1600 px on the long
// side and encoded as JPEG (quality 0.8) before the parent uploads it. With gallery on (the pickup and delivery
// photo steps) a secondary "Choose a photo from your phone" button opens the gallery or files; the picture goes
// through the same downscale and review. The camera stays the primary button. If the camera cannot be opened (no API, permission denied, no camera) the component says so in plain
// words and offers one fallback: an <input type=file accept=image/* capture=environment>, which opens the phone's
// camera app. On some Android phones that input can still offer the gallery (docs/QUESTIONS.md). The camera stream
// is stopped right after the capture and when the component unmounts.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { compressImage } from "@/lib/carrier/image";

export const CAMERA_MAX_SIDE = 1600;
export const CAMERA_QUALITY = 0.8;

export type Captured = { blob: Blob; capturedAt: string };
type Phase = "starting" | "live" | "review" | "unavailable";

type Props = {
  /** What is being photographed, e.g. "Loaded photo". Used in labels and messages. */
  subject: string;
  /** Called with the downscaled JPEG when the person taps Use this photo. */
  onUse: (c: Captured) => void | Promise<void>;
  /** Cancel button (hidden when omitted). */
  onCancel?: () => void;
  /** The parent is uploading the photo: the buttons are disabled and the label says so. */
  busy?: boolean;
  /** The parent's upload error, shown with the review so the photo is not lost. */
  error?: string | null;
  /** Label of the confirm button in the review step. */
  useLabel?: string;
  /** Tells the parent a new picture will be taken (so it can start a new storage path). */
  onRetake?: () => void;
  /** Offer "Choose a photo from your phone" (gallery or files) besides the camera (R41). */
  gallery?: boolean;
};

const BIG = "inline-flex min-h-[64px] w-full cursor-pointer items-center justify-center rounded-full px-6 text-[18px] font-bold disabled:opacity-50";
const SMALL = "inline-flex min-h-[48px] w-full cursor-pointer items-center justify-center rounded-full border border-line bg-white px-6 text-[16px] font-bold text-ink disabled:opacity-50";

function reasonText(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The camera is blocked. Allow the camera for this app in your phone settings, then tap Try the camera again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera was found on this device.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The camera is being used by another app. Close it, then tap Try the camera again.";
  }
  return "The camera could not be opened inside the app.";
}

export function CameraCapture({ subject, onUse, onCancel, busy = false, error = null, useLabel = "Use this photo", onRetake, gallery = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const attempt = useRef(0); // a newer start makes an older, slower one stop its own stream
  const [phase, setPhase] = useState<Phase>("starting");
  const [reason, setReason] = useState("");
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // the video has its first frame
  const [status, setStatus] = useState("Opening the camera.");
  const [fileBusy, setFileBusy] = useState(false);
  const statusId = useId();

  const stopStream = useCallback(() => {
    const s = streamRef.current;
    streamRef.current = null;
    if (s) s.getTracks().forEach((t) => t.stop());
    const v = videoRef.current;
    if (v) v.srcObject = null;
  }, []);

  const start = useCallback(async () => {
    const mine = ++attempt.current;
    stopStream();
    setReady(false);
    setReason("");
    setPhase("starting");
    setStatus("Opening the camera.");
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== "function") {
      setReason("This browser cannot open the camera inside the app.");
      setPhase("unavailable");
      setStatus("The camera is not available.");
      return;
    }
    try {
      const stream = await md.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (!alive.current || mine !== attempt.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        try { await v.play(); } catch { /* autoplay is allowed for a muted inline video; the frame event still fires */ }
      }
      setPhase("live");
      setStatus("Camera ready. Point it at the freight and tap Take photo.");
    } catch (e) {
      if (!alive.current || mine !== attempt.current) return;
      setReason(reasonText(e));
      setPhase("unavailable");
      setStatus("The camera is not available.");
    }
  }, [stopStream]);

  useEffect(() => {
    alive.current = true;
    void start();
    return () => {
      alive.current = false;
      attempt.current += 1;
      stopStream();
    };
  }, [start, stopStream]);

  // Revoke the review preview when it is replaced and on unmount.
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  function showReview(c: Captured) {
    setCaptured(c);
    setPreview(URL.createObjectURL(c.blob));
    setPhase("review");
    setStatus("Photo taken. Tap Use this photo, or Retake.");
  }

  async function take() {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const scale = Math.min(1, CAMERA_MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setReason("This browser cannot process photos.");
      setPhase("unavailable");
      return;
    }
    ctx.drawImage(v, 0, 0, w, h);
    const at = new Date().toISOString();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", CAMERA_QUALITY));
    if (!blob) {
      setStatus("The photo could not be processed. Try again.");
      return;
    }
    stopStream(); // the camera is off as soon as the picture exists
    showReview({ blob, capturedAt: at });
  }

  function retake() {
    onRetake?.();
    setCaptured(null);
    setPreview(null);
    void start();
  }

  async function onFallbackFile(f: File | undefined) {
    if (!f) return;
    setFileBusy(true);
    try {
      const blob = await compressImage(f, CAMERA_MAX_SIDE, CAMERA_QUALITY);
      showReview({ blob, capturedAt: new Date().toISOString() });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not read that photo. Try taking it again.");
    } finally {
      setFileBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="camera" data-phase={phase}>
      <p id={statusId} role="status" aria-live="polite" data-testid="camera-status" className="text-[15px]">{status}</p>

      {/* The video stays mounted so the stream can attach; it is hidden outside the live phase. */}
      <video
        ref={videoRef}
        data-testid="camera-video"
        aria-label={`Live camera view for the ${subject.toLowerCase()}`}
        playsInline
        muted
        autoPlay
        onLoadedData={() => setReady(true)}
        className={`aspect-[3/4] max-h-[60vh] w-full rounded-[12px] bg-black object-cover ${phase === "live" || phase === "starting" ? "" : "hidden"}`}
      />

      {phase === "live" ? (
        <button type="button" data-testid="camera-take" onClick={() => void take()} disabled={!ready || busy} className={`${BIG} bg-ink text-white`}>
          {ready ? "Take photo" : "Getting the camera ready..."}
        </button>
      ) : null}

      {phase === "review" && preview ? (
        <div className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={`${subject}, preview`} data-testid="camera-preview" className="max-h-[60vh] w-full rounded-[12px] bg-black object-contain" />
          {error ? <p role="alert" data-testid="camera-error" className="rounded-[12px] bg-[#F7D9D9] px-4 py-3 text-[15px] text-[#7A1F1F]">{error}</p> : null}
          <button type="button" data-testid="camera-use" onClick={() => captured && void onUse(captured)} disabled={busy || !captured} className={`${BIG} bg-neon text-ink`}>
            {busy ? "Uploading..." : error ? "Try again" : useLabel}
          </button>
          <button type="button" data-testid="camera-retake" onClick={retake} disabled={busy} className={SMALL}>Retake</button>
        </div>
      ) : null}

      {phase === "unavailable" ? (
        <div className="space-y-3" data-testid="camera-unavailable">
          <p role="alert" data-testid="camera-reason" className="rounded-[12px] bg-amber px-4 py-3 text-[15px] text-[#2B1500]">
            {reason} You can open the phone camera app instead and take the picture there.
          </p>
          <button type="button" data-testid="camera-fallback" onClick={() => fileRef.current?.click()} disabled={busy || fileBusy} className={`${BIG} bg-ink text-white`}>
            {fileBusy ? "Reading the photo..." : "Open the phone camera"}
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            tabIndex={-1}
            accept="image/*"
            capture="environment"
            data-testid="camera-fallback-input"
            aria-label={`${subject}, take with the phone camera`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ""; // the same file again must fire change again
              void onFallbackFile(f);
            }}
          />
          <button type="button" data-testid="camera-again" onClick={() => void start()} disabled={busy || fileBusy} className={SMALL}>Try the camera again</button>
        </div>
      ) : null}

      {gallery && phase !== "review" ? (
        <div>
          <button type="button" data-testid="camera-gallery" onClick={() => galleryRef.current?.click()} disabled={busy || fileBusy} className={SMALL}>
            {fileBusy ? "Reading the photo..." : "Choose a photo from your phone"}
          </button>
          {/* image/jpeg, png and webp: iOS converts a HEIC photo to JPEG for this accept list. No capture attribute, so the gallery opens. */}
          <input
            ref={galleryRef}
            type="file"
            hidden
            tabIndex={-1}
            accept="image/jpeg,image/png,image/webp"
            data-testid="camera-gallery-input"
            aria-label={`${subject}, choose from the phone`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void onFallbackFile(f);
            }}
          />
        </div>
      ) : null}

      {onCancel ? (
        <button type="button" onClick={onCancel} disabled={busy} className={SMALL}>Cancel</button>
      ) : null}
    </div>
  );
}
