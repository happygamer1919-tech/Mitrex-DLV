"use client";
import { useActionState, useEffect, useMemo, useState } from "react";
import { Button, Card, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { ActionForm } from "@/components/admin/ActionForm";
import { DropZone } from "@/components/DropZone";
import { createLane, deleteLane, importLanes, updateLane } from "@/lib/admin/lane-actions";
import { MAX_IMPORT_ROWS, validateLaneImport } from "@/lib/admin/lane-csv";
import type { ActionState } from "@/lib/admin/state";

export type LaneRow = {
  id: string; pickupId: string; deliveryId: string; pickup: string; delivery: string; size: number;
  number: string; note: string | null; moffett: boolean; updated: string;
};
export type LocOption = { id: string; name: string; is_active: boolean; requires_moffett: boolean };
export type Prefill = { pickup: string; delivery: string; size: number } | null;

const SIZES = [26, 36, 53];

function AddLane({ locations, prefill, onDone }: { locations: LocOption[]; prefill: Prefill; onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createLane, {});
  // Controlled fields: a refused submit keeps what was typed (an uncontrolled form is reset after every action).
  const [pickup, setPickup] = useState(prefill?.pickup ?? "");
  const [delivery, setDelivery] = useState(prefill?.delivery ?? "");
  const [size, setSize] = useState(String(prefill?.size ?? 26));
  const [number, setNumber] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (state.ok) { setPickup(""); setDelivery(""); setSize("26"); setNumber(""); setNote(""); }
  }, [state]);
  const options = locations.filter((l) => l.is_active || l.id === prefill?.pickup || l.id === prefill?.delivery);
  return (
    <form action={action} className="space-y-3" aria-label="Add lane">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Pickup location">
          <Select name="pickup" required value={pickup} onChange={(e) => setPickup(e.target.value)}>
            <option value="">Choose pickup</option>
            {options.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Delivery location">
          <Select name="delivery" required value={delivery} onChange={(e) => setDelivery(e.target.value)}>
            <option value="">Choose delivery</option>
            {options.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Truck size">
          <Select name="size" required value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((s) => <option key={s} value={s}>{s} ft</option>)}
          </Select>
        </Field>
        <Field label="ITS load to copy" hint="Digits, optionally a dash and digits (313 or 313-2).">
          <Input name="number" required maxLength={30} inputMode="numeric" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} />
        </Field>
      </div>
      <Field label="Note (optional)"><Textarea name="note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="dark" disabled={pending}>{pending ? "Adding..." : "Add lane"}</Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>Close</Button>
      </div>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
    </form>
  );
}

function EditLane({ lane, onDone }: { lane: LaneRow; onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateLane, {});
  useEffect(() => { if (state.ok) onDone(); }, [state.ok, onDone]);
  return (
    <form action={action} className="mt-3 space-y-3 border-t border-line pt-3" aria-label={`Edit ${lane.pickup} to ${lane.delivery}, ${lane.size} ft`}>
      <input type="hidden" name="id" value={lane.id} />
      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        <Field label="ITS load to copy"><Input name="number" required maxLength={30} inputMode="numeric" autoComplete="off" defaultValue={lane.number} /></Field>
        <Field label="Note"><Input name="note" maxLength={500} defaultValue={lane.note ?? ""} /></Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="dark" disabled={pending}>{pending ? "Saving..." : "Save"}</Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>Cancel</Button>
      </div>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
    </form>
  );
}

function Row({ lane }: { lane: LaneRow }) {
  const [editing, setEditing] = useState(false);
  const close = () => setEditing(false);
  return (
    <li data-testid="lane-row" data-lane={`${lane.pickup} > ${lane.delivery} > ${lane.size}`} className="rounded-[16px] border border-line bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[16px] font-bold">{lane.pickup} to {lane.delivery}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="rounded-full bg-[#DCE6F5] px-3 py-1">{lane.size} ft</span>
            <span data-testid="lane-moffett" className={`rounded-full px-3 py-1 ${lane.moffett ? "bg-ink text-white" : "bg-white text-muted ring-1 ring-line"}`}>
              {lane.moffett ? "Moffett" : "No Moffett"}
            </span>
          </div>
          {lane.note ? <p data-testid="lane-note" className="mt-2 break-words text-[15px]">{lane.note}</p> : null}
          <p className="mt-2 text-[13px] text-muted">Last updated by {lane.updated} ET</p>
        </div>
        <div className="text-right">
          <p className="text-[13px] text-muted">ITS load to copy</p>
          <p data-testid="lane-number" className="text-[28px] font-bold leading-tight">{lane.number}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <Button type="button" variant="ghost" onClick={() => setEditing((e) => !e)}>{editing ? "Close" : "Edit"}</Button>
        <ActionForm
          action={deleteLane}
          fields={{ id: lane.id }}
          label="Delete"
          variant="danger"
          confirm={`Delete ${lane.pickup} to ${lane.delivery}, ${lane.size} ft (${lane.number})? This cannot be undone.`}
          confirmLabel="Yes, delete"
          pendingLabel="Deleting..."
          showOk={false}
        />
      </div>
      {editing ? <EditLane lane={lane} onDone={close} /> : null}
    </li>
  );
}

function ImportCard({ locations }: { locations: LocOption[] }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [readError, setReadError] = useState("");
  const [state, action, pending] = useActionState<ActionState, FormData>(importLanes, {});
  useEffect(() => { if (state.ok) { setText(""); setFile(null); } }, [state]);

  const preview = useMemo(() => (text.trim() ? validateLaneImport(text, locations) : null), [text, locations]);
  const badRows = preview ? preview.rows.filter((r) => r.errors.length > 0).length : 0;

  async function onFile(f: File | null) {
    setFile(f);
    setReadError("");
    if (!f) return;
    try { setText(await f.text()); } catch { setReadError("The file could not be read."); }
  }

  return (
    <div className="space-y-3">
      <p className="text-[15px]">
        Columns: <code>shipper, receiver, truck_size, load_to_copy, note</code>. Location names must match the Locations page.
        Rows are added or updated by pickup, delivery and truck size. Nothing is imported unless every row is valid (at most {MAX_IMPORT_ROWS} rows).
      </p>
      <DropZone
        file={file} onFile={onFile} exts={["csv", "txt"]} maxBytes={1_000_000}
        typeError="Choose a .csv or .txt file." sizeError="The file is too large (1 MB at most)."
        label="Lane CSV file" hint="CSV or tab separated text, up to 1 MB"
      />
      <Field label="Or paste the CSV here">
        <Textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false}
          placeholder={"shipper,receiver,truck_size,load_to_copy,note\nMitrex,Howden,26,1234,"} className="font-mono"
        />
      </Field>
      {readError ? <Notice tone="error">{readError}</Notice> : null}
      {preview ? (
        <div className="space-y-3" data-testid="import-preview">
          {preview.fileErrors.map((e) => <Notice key={e} tone="error">{e}</Notice>)}
          {preview.rows.length > 0 ? (
            <>
              <p data-testid="import-summary" className="text-[15px] font-medium">
                {preview.valid ? `${preview.rows.length} row${preview.rows.length === 1 ? "" : "s"}, all valid.` : `${badRows} of ${preview.rows.length} rows have errors. Fix them to import.`}
              </p>
              <div tabIndex={0} role="region" aria-label="Import preview rows" className="overflow-x-auto rounded-[12px] border border-line bg-white">
                <table className="w-full min-w-[640px] text-left text-[14px]">
                  <thead className="bg-mint text-[13px] text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2">Line</th><th scope="col" className="px-3 py-2">Shipper</th>
                      <th scope="col" className="px-3 py-2">Receiver</th><th scope="col" className="px-3 py-2">Size</th>
                      <th scope="col" className="px-3 py-2">Load to copy</th><th scope="col" className="px-3 py-2">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.line} data-testid="preview-row" data-ok={r.errors.length === 0 ? "true" : "false"} className="border-t border-line align-top">
                        <td className="px-3 py-2">{r.line}</td>
                        <td className="px-3 py-2">{r.shipper}</td>
                        <td className="px-3 py-2">{r.receiver}</td>
                        <td className="px-3 py-2">{r.size}</td>
                        <td className="px-3 py-2">{r.number}</td>
                        <td data-testid="preview-result" className={`px-3 py-2 ${r.errors.length ? "text-[#7A1F1F]" : ""}`}>
                          {r.errors.length === 0 ? "OK" : r.errors.join(" ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      <form action={action} className="flex flex-col items-start gap-2">
        <input type="hidden" name="text" value={text} />
        <Button type="submit" variant="dark" disabled={pending || !preview || !preview.valid}>
          {pending ? "Importing..." : "Apply import"}
        </Button>
        {state.error ? <Notice tone="error">{state.error}</Notice> : null}
        {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
      </form>
    </div>
  );
}

export function LaneManager({ lanes, locations, prefill }: { lanes: LaneRow[]; locations: LocOption[]; prefill: Prefill }) {
  const [q, setQ] = useState("");
  const [pickup, setPickup] = useState("all");
  const [delivery, setDelivery] = useState("all");
  const [size, setSize] = useState("all");
  const [adding, setAdding] = useState(prefill !== null);
  const [importing, setImporting] = useState(false);

  const pickups = useMemo(() => [...new Set(lanes.map((l) => l.pickup))].sort((a, b) => a.localeCompare(b)), [lanes]);
  const deliveries = useMemo(() => [...new Set(lanes.map((l) => l.delivery))].sort((a, b) => a.localeCompare(b)), [lanes]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = lanes.filter((l) => {
      if (pickup !== "all" && l.pickup !== pickup) return false;
      if (delivery !== "all" && l.delivery !== delivery) return false;
      if (size !== "all" && String(l.size) !== size) return false;
      if (!needle) return true;
      return [l.pickup, l.delivery, l.number, l.note ?? "", `${l.size}`].some((v) => v.toLowerCase().includes(needle));
    });
    const map = new Map<string, LaneRow[]>();
    for (const l of shown.sort((a, b) => a.pickup.localeCompare(b.pickup) || a.delivery.localeCompare(b.delivery) || a.size - b.size)) {
      const list = map.get(l.pickup) ?? [];
      list.push(l);
      map.set(l.pickup, list);
    }
    return { total: shown.length, groups: [...map.entries()] };
  }, [lanes, q, pickup, delivery, size]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="dark" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close add form" : "Add lane"}</Button>
          <Button type="button" variant="ghost" onClick={() => setImporting((a) => !a)} aria-expanded={importing}>{importing ? "Close import" : "Import CSV"}</Button>
          <a href="/admin/lanes/csv" className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-line px-5 text-[15px] font-bold">Export CSV</a>
        </div>
        {adding ? (
          <div className="mt-4 border-t border-line pt-4">
            {prefill ? <p className="mb-3 text-[15px]" data-testid="lane-prefill-note">Prefilled from the load. Enter the ITS load to copy.</p> : null}
            <AddLane locations={locations} prefill={prefill} onDone={() => setAdding(false)} />
          </div>
        ) : null}
        {importing ? <div className="mt-4 border-t border-line pt-4"><ImportCard locations={locations} /></div> : null}
      </Card>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Location, number or note" /></Field>
          <Field label="Pickup filter">
            <Select value={pickup} onChange={(e) => setPickup(e.target.value)}>
              <option value="all">All pickups</option>
              {pickups.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          <Field label="Delivery filter">
            <Select value={delivery} onChange={(e) => setDelivery(e.target.value)}>
              <option value="all">All deliveries</option>
              {deliveries.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          <Field label="Size filter">
            <Select value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="all">All sizes</option>
              {SIZES.map((s) => <option key={s} value={s}>{s} ft</option>)}
            </Select>
          </Field>
        </div>
      </Card>

      <p data-testid="lane-count" className="text-[13px] text-muted">{groups.total} of {lanes.length} lanes shown. Moffett is derived from the two locations.</p>
      {groups.groups.length === 0 ? (
        <Card><p className="text-[15px] text-muted">{lanes.length === 0 ? "No lanes yet. Add the first one." : "No lanes match this filter."}</p></Card>
      ) : (
        <div className="space-y-6">
          {groups.groups.map(([name, list]) => (
            <section key={name} aria-label={`Pickup ${name}`}>
              <h2 className="mb-2 flex items-center gap-2 text-[18px] font-bold">
                <span>{name}</span>
                <span className="rounded-full bg-white px-2.5 py-0.5 text-[14px] text-muted">{list.length}</span>
              </h2>
              <ul className="space-y-3">{list.map((l) => <Row key={l.id} lane={l} />)}</ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
