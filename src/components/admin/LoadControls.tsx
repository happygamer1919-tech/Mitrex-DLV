"use client";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { DropZone } from "@/components/DropZone";
import { createClient } from "@/lib/supabase/client";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
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

// Some browsers leave file.type empty (heic on non-Apple platforms); the bucket only accepts listed mime types.
const MIME_BY_EXT: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic" };

// Staff upload of a BOL, or of a POD on behalf of the carrier.
export function StaffUpload({ loadId, kind }: { loadId: string; kind: "bol" | "pod" }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const KIND = kind === "bol" ? "BOL" : "POD";

  const inflight = useRef(false); // synchronous lock: a double click or double tap uploads once

  async function upload() {
    if (inflight.current) return;
    setError("");
    setOk("");
    if (!file) { setError("Choose a file first."); return; }
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED.includes(ext)) { setError("Use a PDF or an image (png, jpg, webp, heic)."); return; }
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
        {kind === "bol" ? "Bill of lading (PDF or image, max 15 MB)" : "Proof of delivery, on behalf of the carrier (PDF or image, max 15 MB)"}
      </p>
      <DropZone
        file={file}
        onFile={(f) => { setError(""); setOk(""); setFile(f); }}
        exts={ALLOWED}
        maxBytes={MAX_BYTES}
        typeError="Use a PDF or an image (png, jpg, webp, heic)."
        sizeError="The file is larger than 15 MB."
        label={kind === "bol" ? "Bill of lading" : "Proof of delivery"}
        disabled={busy}
      />
      <Button type="button" onClick={upload} disabled={busy}>{busy ? "Uploading..." : `Upload ${KIND}`}</Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
    </div>
  );
}
