"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Button, Card, Field, Input, Notice } from "@/components/ui";
import { deleteLoadForever } from "@/lib/admin/delete-load-action";
import { failure } from "@/lib/client/action-guard";

type Props = {
  loadId: string;
  confirmText: string; // the ITS number when set, else the request ref
  route: string;
  statusLabel: string;
  documents: number;
};

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// "Danger zone" card for staff_admin only (the page does not render it for anyone else). The button opens a modal that
// names what will be deleted and asks for the load number; the final button stays disabled until the text matches.
export function DeleteLoadCard({ loadId, confirmText, route, statusLabel, documents }: Props) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const inflight = useRef(false); // synchronous double click lock
  const opener = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const [busy, setBusy] = useState(false);
  const matches = typed === confirmText;

  function close() {
    if (busy || inflight.current) return;
    setOpen(false);
    setTyped("");
    setError("");
    opener.current?.focus();
  }

  const closeRef = useRef(close);
  closeRef.current = close;

  // Focus goes into the dialog when it opens; Escape closes it; Tab and Shift+Tab stay inside it (a window level
  // listener, so the trap holds even when focus has fallen back to the page body). Page scroll is locked meanwhile.
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLElement>("input")?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab" || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) { e.preventDefault(); return; }
      // Focus is moved by hand, so the loop holds in every browser (Safari skips buttons when Tab is pressed by default).
      const idx = items.findIndex((el) => el === document.activeElement);
      const next = e.shiftKey ? (idx <= 0 ? items.length - 1 : idx - 1) : (idx < 0 || idx === items.length - 1 ? 0 : idx + 1);
      e.preventDefault();
      items[next].focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  function remove() {
    if (inflight.current || !matches) return;
    inflight.current = true;
    setBusy(true);
    setError("");
    start(async () => {
      try {
        const r = await deleteLoadForever(loadId, typed);
        // Success redirects to /admin and never returns here. A returned state is always a refusal.
        if (r?.error) setError(r.error);
      } catch (e) {
        setError(failure(e).message);
      } finally {
        inflight.current = false;
        setBusy(false);
      }
    });
  }

  return (
    <Card data-testid="danger-zone" className="border-[#7A1F1F]">
      <h2 className="mb-1 text-[20px] font-bold text-[#7A1F1F]">Danger zone</h2>
      <p className="mb-3 text-[15px]">Deleting a load removes it from the system for good. Only an admin can do this.</p>
      <Button type="button" variant="danger" data-testid="delete-open"
        onClick={(e) => { opener.current = e.currentTarget; setTyped(""); setError(""); setOpen(true); }}>
        Delete this load forever
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            data-testid="delete-modal"
            className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-[16px] bg-white p-5 text-ink sm:rounded-[16px]"
          >
            <h2 id={titleId} className="mb-2 text-[20px] font-bold">Delete this load forever?</h2>
            <p id={descId} className="mb-3 text-[15px] font-medium">
              This permanently deletes the load, its timeline, and its BOL and POD files. This cannot be undone.
            </p>
            <dl className="mb-4 divide-y divide-line rounded-[12px] border border-line px-3 text-[15px]" data-testid="delete-summary">
              <div className="flex justify-between gap-3 py-2"><dt className="text-muted">Load</dt><dd className="break-all font-bold">{confirmText}</dd></div>
              <div className="flex justify-between gap-3 py-2"><dt className="text-muted">Route</dt><dd className="text-right">{route}</dd></div>
              <div className="flex justify-between gap-3 py-2"><dt className="text-muted">Status</dt><dd>{statusLabel}</dd></div>
              <div className="flex justify-between gap-3 py-2"><dt className="text-muted">Documents</dt><dd data-testid="delete-doc-count">{documents} {documents === 1 ? "file" : "files"}</dd></div>
            </dl>
            <Field label={`Type ${confirmText} to confirm`} hint="Type it exactly as shown.">
              <Input
                data-testid="delete-confirm-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={40}
                disabled={busy}
              />
            </Field>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" variant="danger" data-testid="delete-confirm" disabled={!matches || busy || pending} onClick={remove}>
                {busy || pending ? "Deleting..." : "Delete forever"}
              </Button>
              <Button type="button" variant="ghost" data-testid="delete-cancel" onClick={close} disabled={busy}>Cancel</Button>
            </div>
            {error ? <div className="mt-3"><Notice tone="error">{error}</Notice></div> : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
