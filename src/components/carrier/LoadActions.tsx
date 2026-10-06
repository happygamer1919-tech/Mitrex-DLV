"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Field, Input, Notice } from "@/components/ui";
import { compressImage } from "@/lib/carrier/image";
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

  async function run(fn: (attempt: Attempt) => Promise<Result>, closeOnOk = true) {
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

  async function deliver(e: React.FormEvent) {
    e.preventDefault();
    if (!podDone && !file) {
      setError("Take a photo of the signed POD to mark this load delivered.");
      return;
    }
    await run(async (attempt) => {
      if (file) {
        const blob = await compressImage(file, 1600, 0.8);
        // Same path on every retry of this photo: if an earlier attempt's upload landed late, the retry
        // finds it ("already exists") instead of storing a second copy. Carriers cannot delete objects,
        // so a fresh path per attempt would leave orphans behind.
        const path = (podPath.current ??= `${loadId}/pod/${crypto.randomUUID()}.jpg`);
        const supabase = createClient();
        const up = await supabase.storage.from("documents").upload(path, blob, { contentType: "image/jpeg", upsert: false });
        const exists = up.error && (/already exists|duplicate/i.test(up.error.message) || String((up.error as { statusCode?: string }).statusCode) === "409");
        if (up.error && !exists) {
          return { ok: false as const, error: "The photo did not upload. Check your connection and tap Try again. The load is not marked delivered." };
        }
        if (attempt.cancelled) return { ok: false as const, error: "Cancelled." }; // the watchdog gave up on this attempt
        const ins = await supabase
          .from("load_documents")
          .insert({ load_id: loadId, kind: "pod", storage_path: path, uploaded_by: userId });
        // 23505: this photo's row already exists (an earlier attempt's insert landed late). That is a saved POD.
        if (ins.error && ins.error.code !== "23505") {
          return { ok: false as const, error: "The photo could not be saved. Tap Try again. The load is not marked delivered." };
        }
        setPodDone(true);
        setFile(null);
      }
      if (attempt.cancelled) return { ok: false as const, error: "Cancelled." };
      return advanceLoad(loadId, "delivered", status);
    });
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
          <form onSubmit={deliver} className="space-y-4">
            <p className="text-[15px]">
              {podDone
                ? "A POD photo is already saved for this load. You can mark it delivered now, or add a clearer photo first."
                : "Take a clear photo of the signed delivery paperwork. It is required to mark the load delivered."}
            </p>
            <Field label={podDone ? "New POD photo (optional)" : "POD photo (required)"}>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busy}
                onChange={(e) => {
                  setError(null);
                  setFailed(false);
                  podPath.current = null;
                  setFile(e.target.files?.[0] ?? null);
                }}
                className="block w-full min-h-[48px] rounded-[12px] border border-line bg-white p-2 text-[15px] text-ink file:mr-3 file:min-h-[40px] file:cursor-pointer file:rounded-full file:border-0 file:bg-ink file:px-4 file:font-bold file:text-white"
              />
            </Field>
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Selected POD photo" className="max-h-56 w-full rounded-[12px] object-contain" />
            ) : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-col gap-2">
              <button type="submit" disabled={busy} data-testid={failed ? "pod-retry" : "pod-submit"} className="inline-flex min-h-[56px] w-full cursor-pointer items-center justify-center rounded-full bg-neon px-6 text-[18px] font-bold text-ink disabled:opacity-50">
                {busy ? "Uploading..." : failed ? "Try again" : "Mark delivered"}
              </button>
              <Button type="button" variant="ghost" className="min-h-[48px]" onClick={close} disabled={busy}>Cancel</Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
