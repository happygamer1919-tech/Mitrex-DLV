"use client";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { DropZone } from "@/components/DropZone";
import { createClient } from "@/lib/supabase/client";
import { STATUS_LABEL, type DocKind, type LoadStatus } from "@/lib/types";
import { removeLoadPhoto } from "@/lib/carrier/photo-actions";
import { assignCarrier, bookLoad, notifyBolUploaded, overrideStatus, setEta, setItsNumber } from "@/lib/admin/load-actions";
import { validateIts } from "@/lib/load-number";
import type { ActionState } from "@/lib/admin/state";

export function AssignCarrierForm({
  loadId, carrierId, carriers,
}: { loadId: string; carrierId: string | null; carriers: { id: string; name: string; is_active: boolean }[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(assignCarrier, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="load_id" value={loadId} />
      <Field label="Carrier">
        <Select name="carrier_id" defaultValue={carrierId ?? ""}>
          <option value="">No carrier</option>
          {carriers.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.is_active && c.id !== carrierId}>
              {c.name}{c.is_active ? "" : " (inactive)"}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Saving..." : "Save carrier"}</Button>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
    </form>
  );
}

// Mark booked: needs a saved carrier AND the ITS load number (the database enforces the number too).
export function BookLoadForm({ loadId, carrierSaved, itsNumber }: { loadId: string; carrierSaved: boolean; itsNumber: string | null }) {
  const [its, setIts] = useState(itsNumber ?? "");
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState>({});
  const missing: string[] = [];
  if (!carrierSaved) missing.push("Assign a carrier");
  if (!its.trim()) missing.push("Enter the ITS load number");
  const blocked = missing.length > 0;
  function book() {
    const bad = validateIts(its);
    if (bad) { setState({ error: bad }); return; }
    setState({});
    start(async () => {
      try {
        setState(await bookLoad(loadId, its));
      } catch {
        setState({ error: "Something went wrong. Please try again." });
      }
    });
  }
  return (
    <div className="space-y-3" data-testid="book-card">
      <Field label="ITS load number (required to book)" hint="Enter the new load number from ITS.">
        <Input name="its_load_number" inputMode="numeric" autoComplete="off" maxLength={30} value={its}
          onChange={(e) => setIts(e.target.value)} data-testid="its-input" />
      </Field>
      <p className="text-[13px] text-muted">Booking emails every user of the assigned carrier and every active customer user, with the BOL if there is one.</p>
      <Button type="button" variant="primary" disabled={blocked || pending} onClick={book}>
        {pending ? "Booking..." : "Mark booked"}
      </Button>
      {blocked ? (
        <p data-testid="book-missing" className="text-[14px] font-medium">{missing.join(". ")}.</p>
      ) : null}
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
    </div>
  );
}

// Staff correct the ITS number after booking (same database function, the change is logged in the timeline).
export function EditItsForm({ loadId, itsNumber }: { loadId: string; itsNumber: string | null }) {
  const [open, setOpen] = useState(false);
  const [its, setIts] = useState(itsNumber ?? "");
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState>({});
  function save() {
    const bad = validateIts(its);
    if (bad) { setState({ error: bad }); return; }
    setState({});
    start(async () => {
      try {
        const r = await setItsNumber(loadId, its);
        setState(r);
        if (r.ok) setOpen(false);
      } catch {
        setState({ error: "Something went wrong. Please try again." });
      }
    });
  }
  return (
    <div className="space-y-3" data-testid="its-card">
      <p className="text-[15px]">
        ITS load number: <span data-testid="its-current" className="font-bold">{itsNumber ?? "not set (legacy load)"}</span>
      </p>
      {!open ? (
        <Button type="button" variant="ghost" onClick={() => { setIts(itsNumber ?? ""); setState({}); setOpen(true); }}>
          Edit ITS number
        </Button>
      ) : (
        <div className="space-y-3">
          <Field label="ITS load number" hint="Enter the load number from ITS. The change is logged in the timeline.">
            <Input inputMode="numeric" autoComplete="off" maxLength={30} value={its} onChange={(e) => setIts(e.target.value)} data-testid="its-edit-input" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={save} disabled={pending || !its.trim()}>{pending ? "Saving..." : "Save ITS number"}</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Keep</Button>
          </div>
        </div>
      )}
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
    </div>
  );
}

export function StatusOverrideForm({ loadId, current, itsNumber }: { loadId: string; current: LoadStatus; itsNumber: string | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(overrideStatus, {});
  const [status, setStatus] = useState<LoadStatus | "">("");
  const statusRef = useRef<HTMLSelectElement>(null);
  // React resets the form after every action. WebKit then blanks a controlled select (its DOM value
  // goes back to the disabled placeholder) while state still holds the choice, so a second submit is
  // blocked by the browser's required check. Put the choice back after each result.
  useEffect(() => {
    if (statusRef.current && status) statusRef.current.value = status;
  }, [state, status]);
  const options = (Object.keys(STATUS_LABEL) as LoadStatus[]).filter((s) => s !== current);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="load_id" value={loadId} />
      <Field label="New status">
        <Select ref={statusRef} name="status" required value={status} onChange={(e) => setStatus(e.target.value as LoadStatus)}>
          <option value="" disabled>Choose a status</option>
          {options.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </Select>
      </Field>
      {status === "enroute" ? (
        <Field label="ETA (Eastern time, ET)">
          <Input type="datetime-local" name="eta" required />
        </Field>
      ) : null}
      {current === "requested" && status && status !== "cancelled" ? (
        <Field label="ITS load number (required to leave Requested)" hint="Enter the new load number from ITS.">
          <Input name="its_load_number" inputMode="numeric" autoComplete="off" maxLength={30} required defaultValue={itsNumber ?? ""} data-testid="override-its-input" />
        </Field>
      ) : null}
      <Field label="Note (required)" hint="Recorded in the timeline.">
        <Textarea name="note" required rows={2} maxLength={500} />
      </Field>
      <Button type="submit" variant="dark" disabled={pending || !status}>
        {pending ? "Saving..." : "Override status"}
      </Button>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
    </form>
  );
}

export function EtaForm({ loadId, etaLocal }: { loadId: string; etaLocal: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setEta, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="load_id" value={loadId} />
      <Field label="ETA (Eastern time, ET)">
        <Input type="datetime-local" name="eta" required defaultValue={etaLocal} />
      </Field>
      <Field label="Note (optional)">
        <Input name="note" maxLength={200} />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Saving..." : "Update ETA"}</Button>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
    </form>
  );
}

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = ["pdf", "png", "jpg", "jpeg", "webp", "heic"];
const PHOTO_ALLOWED = ["png", "jpg", "jpeg", "webp"]; // the database accepts only these for a photo kind (0018)
const KIND_NAME: Record<DocKind, string> = { bol: "BOL", pod: "POD", pickup_photo: "Pickup photo", delivery_photo: "Delivery photo" };
const KIND_HELP: Record<DocKind, string> = {
  bol: "Bill of lading (PDF or image, max 15 MB)",
  pod: "Proof of delivery, on behalf of the carrier (PDF or image, max 15 MB)",
  pickup_photo: "Pickup photo of the loaded freight, on behalf of the carrier (png, jpg or webp, max 15 MB)",
  delivery_photo: "Delivery photo, on behalf of the carrier (png, jpg or webp, max 15 MB)",
};

// Some browsers leave file.type empty (heic on non-Apple platforms); the bucket only accepts listed mime types.
const MIME_BY_EXT: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic" };

// Staff upload of a BOL, or of a POD or a pickup or delivery photo on behalf of the carrier.
export function StaffUpload({ loadId, kind }: { loadId: string; kind: DocKind }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const KIND = KIND_NAME[kind];
  const isPhoto = kind === "pickup_photo" || kind === "delivery_photo";
  const allowed = isPhoto ? PHOTO_ALLOWED : ALLOWED;
  const typeText = isPhoto ? "Use a photo (png, jpg or webp)." : "Use a PDF or an image (png, jpg, webp, heic).";

  const inflight = useRef(false); // synchronous lock: a double click or double tap uploads once

  async function upload() {
    if (inflight.current) return;
    setError("");
    setOk("");
    if (!file) { setError("Choose a file first."); return; }
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!allowed.includes(ext)) { setError(typeText); return; }
    if (file.size > MAX_BYTES) { setError("The file is larger than 15 MB."); return; }

    inflight.current = true;
    setBusy(true);
    try {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) { setError("Your session expired. Sign in again."); return; }
      const path = `${loadId}/${kind}/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from("documents").upload(path, file, { contentType: file.type || MIME_BY_EXT[ext] });
      if (up.error) { setError(up.error.message); return; }
      const ins = await supabase.from("load_documents").insert({
        load_id: loadId, kind, storage_path: path, uploaded_by: auth.user.id,
      });
      if (ins.error) {
        await supabase.storage.from("documents").remove([path]);
        setError(ins.error.message);
        return;
      }
      setFile(null);
      setOk(`${KIND} uploaded.`);
      if (kind === "bol") {
        // Booked load: the customer gets the BOL by email. The server action decides (staff only, not while requested).
        try { await notifyBolUploaded(loadId, path); } catch { /* the upload itself succeeded */ }
      }
      router.refresh();
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-testid={`upload-${kind}`}>
      <p className="text-[13px] font-medium text-muted">
        {KIND_HELP[kind]}
      </p>
      <DropZone
        file={file}
        onFile={(f) => { setError(""); setOk(""); setFile(f); }}
        exts={allowed}
        maxBytes={MAX_BYTES}
        typeError={typeText}
        sizeError="The file is larger than 15 MB."
        label={kind === "bol" ? "Bill of lading" : kind === "pod" ? "Proof of delivery" : KIND_NAME[kind]}
        disabled={busy}
      />
      <Button type="button" onClick={upload} disabled={busy}>{busy ? "Uploading..." : `Upload ${KIND}`}</Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
    </div>
  );
}

// Staff remove a stored photo (any photo, any status). The database function decides; the file goes with it.
export function RemovePhotoButton({ loadId, docId, label }: { loadId: string; docId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const r = await removeLoadPhoto(loadId, docId);
      if (!r.ok) setError(r.error);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" onClick={() => void remove()} disabled={busy} aria-label={`Remove ${label}`} data-testid="staff-photo-remove"
        className="inline-flex min-h-[44px] cursor-pointer items-center rounded-full border border-line px-5 text-[15px] font-bold disabled:opacity-50">
        {busy ? "Removing..." : "Remove"}
      </button>
      {error ? <span role="alert" className="text-[13px] text-[#7A1F1F]">{error}</span> : null}
    </span>
  );
}
