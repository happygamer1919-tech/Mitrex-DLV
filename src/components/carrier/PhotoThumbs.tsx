"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { removeLoadPhoto } from "@/lib/carrier/photo-actions";
import { failure, goToLogin, withTimeout } from "@/lib/client/action-guard";
import type { PhotoItem } from "@/lib/carrier/photos";

// The photos already stored for the open step, with the SERVER time of each (Eastern time). A carrier can remove a
// photo it took itself while the step is still open (the database decides; this list only offers the button).
export function PhotoThumbs({ loadId, photos, canRemove }: { loadId: string; photos: PhotoItem[]; canRemove: boolean }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inflight = useRef(false);

  async function remove(id: string) {
    if (inflight.current) return;
    inflight.current = true;
    setBusyId(id);
    setError("");
    try {
      const res = await withTimeout(removeLoadPhoto(loadId, id));
      if (!res.ok) {
        if (res.code === "auth") { goToLogin(); return; }
        setError(res.error);
      }
      router.refresh();
    } catch (e) {
      const f = failure(e);
      if (f.sessionExpired) { goToLogin(); return; }
      setError(f.message);
    } finally {
      inflight.current = false;
      setBusyId(null);
    }
  }

  if (photos.length === 0) return null;
  return (
    <div className="space-y-2">
      <ul className="grid grid-cols-2 gap-3" data-testid="photo-list">
        {photos.map((p, i) => (
          <li key={p.id} data-testid="photo-item" className="space-y-1 rounded-[12px] border border-line p-2">
            {p.url ? (
              <a href={p.url} target="_blank" rel="noopener noreferrer" aria-label={`Open photo ${i + 1} full size`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={`Photo ${i + 1}`} className="aspect-[4/3] w-full rounded-[8px] bg-black object-cover" />
              </a>
            ) : (
              <p className="flex aspect-[4/3] items-center justify-center rounded-[8px] bg-mint text-[13px] text-muted">Preview unavailable</p>
            )}
            <p className="text-[13px] text-muted" data-testid="photo-time">{p.when}</p>
            {p.mine && canRemove ? (
              <button
                type="button"
                onClick={() => void remove(p.id)}
                disabled={busyId !== null}
                data-testid="photo-remove"
                aria-label={`Remove photo ${i + 1}`}
                className="inline-flex min-h-[48px] w-full cursor-pointer items-center justify-center rounded-full border border-line bg-white px-4 text-[15px] font-bold text-ink disabled:opacity-50"
              >
                {busyId === p.id ? "Removing..." : "Remove"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="rounded-[12px] bg-[#F7D9D9] px-4 py-3 text-[15px] text-[#7A1F1F]">{error}</p> : null}
    </div>
  );
}
