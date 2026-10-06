"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Notice } from "@/components/ui";
import { DropZone } from "@/components/DropZone";
import { storePodPhoto } from "@/lib/carrier/pod-upload";
import { POD_EXTS, POD_MAX_BYTES } from "@/components/carrier/PodCard";
import { NEXT_LABEL, NEXT_STATUS } from "@/lib/carrier/loads";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import { advanceLoad, updateEta } from "@/app/my-loads/[id]/actions";
import { failure, goToLogin, withTimeout } from "@/lib/client/action-guard";

// One attempt of a mutation. After the watchdog fires the attempt is cancelled: its late result is
// ignored and it must not start another step (so a retry cannot double up a POD).
type Attempt = { cancelled: boolean };
type Result = { ok: true } | { ok: false; error: string; code?: "auth" | "stale" };

type Props = {
  loadId: string;
  userId: string;
  status: LoadStatus;
  etaLabel: string | null; // already formatted in ET
  etaLocal: string | null; // Eastern wall clock for datetime-local
  defaultEtaLocal: string; // delivery appointment or window start
  hasPod: boolean;
};

type ModalKind = "enroute" | "pod" | "eta" | null;

function Modal({ title, onClose, busy, children }: { title: string; onClose: () => void; busy: boolean; children: React.ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-[16px] bg-white p-5 text-ink sm:rounded-[16px]"
      >
        <h2 id={titleId} className="mb-4 text-[20px] font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function LoadActions({ loadId, userId, status, etaLabel, etaLocal, defaultEtaLocal, hasPod }: Props) {
  const router = useRouter();
  const [modal, setModal] = useState<ModalKind>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [etaValue, setEtaValue] = useState(etaLocal ?? defaultEtaLocal);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [podDone, setPodDone] = useState(hasPod);
  const [failed, setFailed] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false); // the chosen photo did not upload: offer "deliver without photo"
  const stage = useRef<"photo" | "status">("status");
  const podPath = useRef<string | null>(null); // one storage path per chosen photo, reused by every retry
  const inflight = useRef(false); // synchronous double tap lock; `busy` only disables after a render

  useEffect(() => {
    if (hasPod) setPodDone(true);
  }, [hasPod]);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const next = NEXT_STATUS[status];
  if (!next) return null;
  const canEditEta = status === "enroute" || status === "at_delivery";

  function open(kind: Exclude<ModalKind, null>) {
    setError(null);
    setFailed(false);
    setPhotoFailed(false);
    setFile(null);
    podPath.current = null;
    setEtaValue(kind === "eta" ? (etaLocal ?? defaultEtaLocal) : defaultEtaLocal);
    setModal(kind);
  }

  function close() {
    if (busy) return;
    setModal(null);
    setError(null);
  }

  async function run(fn: (attempt: Attempt) => Promise<Result>, closeOnOk = true, onFail?: () => void) {
    if (inflight.current) return;
    inflight.current = true;
    const attempt: Attempt = { cancelled: false };
    setBusy(true);
    setError(null);
    try {
      const res = await withTimeout(fn(attempt));
      if (!res.ok) {
        if (res.code === "auth") {
          goToLogin();
          return;
        }
        setError(res.error);
        setFailed(true);
        onFail?.();
        if (res.code === "stale") {
          setModal(null);
          router.refresh();
        }
        return;
      }
      setFailed(false);
      if (closeOnOk) setModal(null);
      router.refresh();
    } catch (e) {
      attempt.cancelled = true;
      const f = failure(e);
      if (f.sessionExpired) {
        goToLogin();
        return;
      }
      setError(f.message);
      setFailed(true);
      onFail?.();
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  function onBigButton() {
    const target = NEXT_STATUS[status];
    if (!target) return;
    if (target === "enroute") return open("enroute");
    if (target === "delivered") return open("pod");
    void run(() => advanceLoad(loadId, target, status), false);
  }

  function confirmEnroute(e: React.FormEvent) {
    e.preventDefault();
    if (!etaValue) {
      setError("Enter the delivery ETA before you leave.");
      return;
    }
    void run(() => advanceLoad(loadId, "enroute", status, etaValue));
  }

  function saveEta(e: React.FormEvent) {
    e.preventDefault();
    if (!etaValue) {
      setError("Enter the new delivery ETA.");
      return;
    }
    void run(() => updateEta(loadId, etaValue));
  }

  // A POD photo is optional. With a photo chosen it is stored first (never silently dropped: if it fails the
  // carrier chooses Try again or Mark delivered without photo); without one the load is delivered at once.
  async function deliver(e: React.FormEvent | null, skipPhoto = false) {
    e?.preventDefault();
    if (skipPhoto) { setFile(null); podPath.current = null; }
    const withPhoto = file && !skipPhoto;
    await run(async (attempt) => {
      if (withPhoto) {
        stage.current = "photo";
        const res = await storePodPhoto({ loadId, userId, file, pathRef: podPath, attempt });
        if (!res.ok) {
          if (res.step === "cancelled") return { ok: false as const, error: "Cancelled." };
          return {
            ok: false as const,
            error: res.step === "upload"
              ? "The photo did not upload. The load is not marked delivered yet. Tap Try again, or choose Mark delivered without photo and add the photo later."
              : "The photo could not be saved. The load is not marked delivered yet. Tap Try again, or choose Mark delivered without photo and add the photo later.",
          };
        }
        setPodDone(true);
        setFile(null);
      }
      stage.current = "status";
      if (attempt.cancelled) return { ok: false as const, error: "Cancelled." };
      return advanceLoad(loadId, "delivered", status);
    }, true, () => setPhotoFailed(stage.current === "photo" && Boolean(withPhoto)));
  }

  return (
    <div className="space-y-3">
      {canEditEta ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-white/10 p-4">
          <div>
            <div className="text-[13px] font-medium text-white/80">Delivery ETA</div>
            <div className="text-[20px] font-bold text-white">{etaLabel ?? "Not set"}</div>
          </div>
          <Button type="button" variant="white" className="min-h-[48px]" onClick={() => open("eta")}>
            Update ETA
          </Button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onBigButton}
        disabled={busy}
        data-testid="next-step"
        className="inline-flex min-h-[64px] w-full cursor-pointer items-center justify-center rounded-full bg-neon px-6 text-[20px] font-bold text-ink disabled:opacity-50"
      >
        {busy && modal === null ? "Saving..." : NEXT_LABEL[next]}
      </button>
      <p className="text-center text-[13px] text-white/80">Next status: {STATUS_LABEL[next]}</p>
      {error && modal === null ? <Notice tone="error">{error}</Notice> : null}

      {modal === "enroute" ? (
        <Modal title="Confirm delivery ETA" onClose={close} busy={busy}>
          <form onSubmit={confirmEnroute} className="space-y-4">
            <Field label="Estimated arrival at delivery (Eastern time, ET)" hint="Dispatch and the customer see this time.">
              <Input type="datetime-local" className="min-w-0 max-w-full" required value={etaValue} onChange={(e) => setEtaValue(e.target.value)} disabled={busy} />
            </Field>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-col gap-2">
              <button type="submit" disabled={busy} className="inline-flex min-h-[56px] w-full cursor-pointer items-center justify-center rounded-full bg-neon px-6 text-[18px] font-bold text-ink disabled:opacity-50">
                {busy ? "Saving..." : failed ? "Try again" : "Confirm ETA and leave"}
              </button>
              <Button type="button" variant="ghost" className="min-h-[48px]" onClick={close} disabled={busy}>Cancel</Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "eta" ? (
        <Modal title="Update delivery ETA" onClose={close} busy={busy}>
          <form onSubmit={saveEta} className="space-y-4">
            <Field label="New ETA (Eastern time, ET)">
              <Input type="datetime-local" className="min-w-0 max-w-full" required value={etaValue} onChange={(e) => setEtaValue(e.target.value)} disabled={busy} />
            </Field>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-col gap-2">
              <Button type="submit" variant="dark" className="min-h-[56px]" disabled={busy}>{busy ? "Saving..." : failed ? "Try again" : "Save ETA"}</Button>
              <Button type="button" variant="ghost" className="min-h-[48px]" onClick={close} disabled={busy}>Cancel</Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "pod" ? (
        <Modal title="Proof of delivery" onClose={close} busy={busy}>
          <form onSubmit={(e) => void deliver(e)} className="space-y-4">
            <p className="text-[15px]">
              {podDone
                ? "A POD photo is already saved for this load. You can mark it delivered now, or add a clearer photo first."
                : "Add the signed POD photo now if you have it. You can add it later from this load."}
            </p>
            <DropZone
              file={file}
              onFile={(f) => {
                setError(null);
                setFailed(false);
                setPhotoFailed(false);
                podPath.current = null;
                setFile(f);
              }}
              exts={POD_EXTS}
              maxBytes={POD_MAX_BYTES}
              typeError="Use a photo (jpg, png, webp or heic)."
              sizeError="The photo is larger than 15 MB."
              label={podDone ? "New POD photo (optional)" : "POD photo (optional)"}
              camera
              driver
              disabled={busy}
            />
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Selected POD photo" className="max-h-56 w-full rounded-[12px] object-contain" />
            ) : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-col gap-2">
              <button type="submit" disabled={busy} data-testid={failed ? "pod-retry" : "pod-submit"} className="inline-flex min-h-[56px] w-full cursor-pointer items-center justify-center rounded-full bg-neon px-6 text-[18px] font-bold text-ink disabled:opacity-50">
                {busy ? (file ? "Uploading..." : "Saving...") : failed ? "Try again" : "Mark delivered"}
              </button>
              {photoFailed ? (
                <button type="button" disabled={busy} data-testid="pod-skip" onClick={() => void deliver(null, true)} className="inline-flex min-h-[56px] w-full cursor-pointer items-center justify-center rounded-full border border-line bg-white px-6 text-[16px] font-bold text-ink disabled:opacity-50">
                  Mark delivered without photo
                </button>
              ) : null}
              <Button type="button" variant="ghost" className="min-h-[48px]" onClick={close} disabled={busy}>Cancel</Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
