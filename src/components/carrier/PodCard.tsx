"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { btnClass, Button, Card, Notice } from "@/components/ui";
import { DropZone } from "@/components/DropZone";
import { storePodPhoto } from "@/lib/carrier/pod-upload";
import { failure, goToLogin, withTimeout } from "@/lib/client/action-guard";

export const POD_EXTS = ["jpg", "jpeg", "png", "webp", "heic"];
export const POD_MAX_BYTES = 15 * 1024 * 1024;

// Carrier "Proof of delivery" card on a delivered load: add the POD photo after delivery, or another one.
export function PodCard({ loadId, userId, pods }: { loadId: string; userId: string; pods: { id: string; url: string | null }[] }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(pods.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const pathRef = useRef<string | null>(null); // one storage path per chosen photo, reused by a retry
  const inflight = useRef(false);

  async function add() {
    if (inflight.current) return;
    if (!file) { setError("Choose or take a photo first."); return; }
    inflight.current = true;
    const attempt = { cancelled: false };
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await withTimeout(storePodPhoto({ loadId, userId, file, pathRef, attempt }));
      if (!res.ok) {
        setError(res.step === "save"
          ? "The photo could not be saved. Tap Try again."
          : "The photo did not upload. Check your connection and tap Try again.");
        return;
      }
      setOk("POD photo added.");
      setFile(null);
      pathRef.current = null;
      setAdding(false);
      router.refresh();
    } catch (e) {
      attempt.cancelled = true;
      const f = failure(e);
      if (f.sessionExpired) { goToLogin(); return; }
      setError(f.message);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  const failed = Boolean(error);
  return (
    <Card className="space-y-3 text-ink" data-testid="pod-card">
      <h2 className="text-[20px] font-bold">Proof of delivery</h2>
      {pods.length === 0 ? (
        <Notice tone="warn">
          <span data-testid="pod-missing">POD not uploaded yet</span>. Add the signed POD photo when you have it.
        </Notice>
      ) : (
        <div className="flex flex-wrap gap-3">
          {pods.map((p, i) => p.url ? (
            <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className={`${btnClass("ghost")} min-h-[48px]`}>
              View POD{pods.length > 1 ? ` ${i + 1}` : ""}
            </a>
          ) : (
            <span key={p.id} className="text-[15px] text-muted">POD {i + 1} is unavailable right now. Refresh the page.</span>
          ))}
        </div>
      )}
      {adding ? (
        <div className="space-y-3">
          <DropZone
            file={file}
            onFile={(f) => { setError(""); setOk(""); pathRef.current = null; setFile(f); }}
            exts={POD_EXTS}
            maxBytes={POD_MAX_BYTES}
            typeError="Use a photo (jpg, png, webp or heic)."
            sizeError="The photo is larger than 15 MB."
            label="POD photo"
            camera
            driver
            disabled={busy}
          />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button type="button" className="min-h-[56px] w-full" variant="dark" onClick={add} disabled={busy} data-testid="pod-add">
            {busy ? "Uploading..." : failed ? "Try again" : "Add POD photo"}
          </Button>
          {pods.length > 0 ? (
            <Button type="button" variant="ghost" className="min-h-[48px] w-full" onClick={() => { setAdding(false); setFile(null); setError(""); }} disabled={busy}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : (
        <Button type="button" variant="ghost" className="min-h-[48px] w-full" onClick={() => { setOk(""); setAdding(true); }} data-testid="pod-add-another">
          Add another
        </Button>
      )}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
    </Card>
  );
}
