"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import { assignCarrier, overrideStatus, setEta } from "@/lib/admin/load-actions";
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

export function StatusOverrideForm({ loadId, current }: { loadId: string; current: LoadStatus }) {
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

export function BolUpload({ loadId }: { loadId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function upload() {
    setError("");
    setOk("");
    const file = input.current?.files?.[0];
    if (!file) { setError("Choose a file first."); return; }
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED.includes(ext)) { setError("Use a PDF or an image (png, jpg, webp, heic)."); return; }
    if (file.size > MAX_BYTES) { setError("The file is larger than 15 MB."); return; }

    setBusy(true);
    try {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) { setError("Your session expired. Sign in again."); return; }
      const path = `${loadId}/bol/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from("documents").upload(path, file, { contentType: file.type || MIME_BY_EXT[ext] });
      if (up.error) { setError(up.error.message); return; }
      const ins = await supabase.from("load_documents").insert({
        load_id: loadId, kind: "bol", storage_path: path, uploaded_by: auth.user.id,
      });
      if (ins.error) {
        await supabase.storage.from("documents").remove([path]);
        setError(ins.error.message);
        return;
      }
      if (input.current) input.current.value = "";
      setOk("BOL uploaded.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Bill of lading (PDF or image, max 15 MB)">
        <input
          ref={input}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,application/pdf,image/*"
          className="block min-h-[44px] w-full text-[15px]"
        />
      </Field>
      <Button type="button" onClick={upload} disabled={busy}>{busy ? "Uploading..." : "Upload BOL"}</Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
    </div>
  );
}
