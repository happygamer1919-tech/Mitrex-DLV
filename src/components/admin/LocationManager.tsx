"use client";
import { useActionState, useEffect, useMemo, useState } from "react";
import { Button, Card, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { ActionForm } from "@/components/admin/ActionForm";
import { deleteLocation, saveLocation, setLocationActive } from "@/lib/admin/location-actions";
import type { Location } from "@/lib/types";
import { nameIsStreet } from "@/lib/address";
import type { ActionState } from "@/lib/admin/state";
import { guardAction } from "@/lib/client/action-guard";
import { fmtDateTime } from "@/lib/format";

// R45: profile id to display name, for the "Added by" and "Last edited by" lines.
export type LocationAuthors = Record<string, string>;

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex min-h-[44px] items-center gap-3 text-[15px]">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-5 w-5 accent-[#020814]" />
      {label}
    </label>
  );
}

function LocationForm({ location, onDone, onCancel }: { location?: Location; onDone: () => void; onCancel: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(guardAction(saveLocation), {});
  useEffect(() => { if (state.ok) onDone(); }, [state.ok, onDone]);
  return (
    <form action={action} className="space-y-3">
      {location ? <input type="hidden" name="id" value={location.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input name="name" required maxLength={120} defaultValue={location?.name} /></Field>
        <Field label="Address line"><Input name="address_line" required maxLength={200} defaultValue={location?.address_line} /></Field>
        <Field label="City"><Input name="city" required maxLength={80} defaultValue={location?.city} /></Field>
        <Field label="Province"><Input name="province" required maxLength={2} defaultValue={location?.province ?? "ON"} /></Field>
        <Field label="Postal code" hint="Leave empty to flag the location for review.">
          <Input name="postal_code" maxLength={10} defaultValue={location?.postal_code ?? ""} />
        </Field>
        <Field label="Default contact name"><Input name="default_contact_name" maxLength={120} defaultValue={location?.default_contact_name ?? ""} /></Field>
        <Field label="Default contact phone"><Input name="default_contact_phone" type="tel" maxLength={40} defaultValue={location?.default_contact_phone ?? ""} /></Field>
      </div>
      <Field label="Notes"><Textarea name="notes" rows={2} maxLength={500} defaultValue={location?.notes ?? ""} /></Field>
      <div className="grid sm:grid-cols-2">
        <Check name="can_ship" label="Can ship (pickup)" defaultChecked={location?.can_ship ?? true} />
        <Check name="can_receive" label="Can receive (delivery)" defaultChecked={location?.can_receive ?? true} />
        <Check name="requires_moffett" label="Requires Moffett" defaultChecked={location?.requires_moffett} />
        <Check name="needs_review" label="Needs review" defaultChecked={location?.needs_review} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving..." : location ? "Save changes" : "Create location"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
      </div>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
    </form>
  );
}

// R46: a compact row (name, place, badges and the actions on one line). "Edit" expands the row: the contact, the notes,
// who added and last edited it, and the edit form. The collapsed part stays in the page (hidden), so a find on the page
// still lands on it after expanding.
function Row({ loc, authors }: { loc: Location; authors: LocationAuthors }) {
  const addedBy = loc.created_by ? authors[loc.created_by] : undefined;
  const editedBy = loc.updated_by ? authors[loc.updated_by] : undefined;
  const [editing, setEditing] = useState(false);
  const close = () => setEditing(false);
  const panelId = `loc-panel-${loc.id}`;
  return (
    // A plain div, not Card: Card already sets border-line, and two border colors on one element leave the winner to CSS order.
    <div data-testid="location-row" className={`rounded-[16px] bg-card px-4 py-2 ${loc.needs_review ? "border-2 border-amber" : "border border-line"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <p className="min-w-0 max-w-full text-[16px] font-bold [overflow-wrap:anywhere]">{loc.name}</p>
          <p className="min-w-0 max-w-full text-[14px] text-muted [overflow-wrap:anywhere]">
            {nameIsStreet(loc) ? "" : `${loc.address_line}, `}{loc.city}, {loc.province} {loc.postal_code ?? ""}
          </p>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            {!loc.is_active ? <span className="rounded-full bg-[#F7D9D9] px-2.5 py-0.5 text-[#7A1F1F]">Inactive</span> : null}
            {loc.needs_review ? <span className="rounded-full bg-amber px-2.5 py-0.5 text-[#2B1500]">Needs review</span> : null}
            {loc.can_ship ? <span className="rounded-full bg-[#DCE6F5] px-2.5 py-0.5">Ships</span> : null}
            {loc.can_receive ? <span className="rounded-full bg-[#DCE6F5] px-2.5 py-0.5">Receives</span> : null}
            {loc.requires_moffett ? <span className="rounded-full bg-ink px-2.5 py-0.5 text-white">Moffett</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Button type="button" variant="ghost" aria-expanded={editing} aria-controls={panelId} onClick={() => setEditing((e) => !e)}>{editing ? "Close" : "Edit"}</Button>
          <ActionForm
            action={setLocationActive}
            fields={{ id: loc.id, active: loc.is_active ? "false" : "true" }}
            label={loc.is_active ? "Deactivate" : "Activate"}
            variant="ghost"
            showOk={false}
          />
          <ActionForm
            action={deleteLocation}
            fields={{ id: loc.id }}
            label="Delete"
            variant="danger"
            confirm={`Delete ${loc.name}? This cannot be undone.`}
            confirmLabel="Yes, delete"
            pendingLabel="Deleting..."
            showOk={false}
          />
        </div>
      </div>
      <div id={panelId} hidden={!editing} data-testid="location-panel" className="mt-3 border-t border-line pt-3">
        {loc.default_contact_name || loc.default_contact_phone ? (
          <p className="text-[13px] text-muted">
            Contact: {[loc.default_contact_name, loc.default_contact_phone].filter(Boolean).join(", ")}
          </p>
        ) : null}
        {loc.notes ? <p className="mt-1 text-[13px] text-muted">{loc.notes}</p> : null}
        {addedBy && loc.created_at ? (
          <p className="mt-1 break-words text-[13px] text-muted" data-testid="location-added-by">Added by {addedBy}, {fmtDateTime(loc.created_at)}</p>
        ) : null}
        {editedBy && loc.updated_at ? (
          <p className="mt-1 break-words text-[13px] text-muted" data-testid="location-edited-by">Last edited by {editedBy}, {fmtDateTime(loc.updated_at)}</p>
        ) : null}
        {editing ? <div className="mt-3"><LocationForm location={loc} onDone={close} onCancel={close} /></div> : null}
      </div>
    </div>
  );
}

export function LocationManager({ locations, authors = {} }: { locations: Location[]; authors?: LocationAuthors }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const closeCreate = () => setCreating(false);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return locations.filter((l) => {
      if (filter === "active" && !l.is_active) return false;
      if (filter === "inactive" && l.is_active) return false;
      if (filter === "review" && !l.needs_review) return false;
      if (filter === "ship" && !l.can_ship) return false;
      if (filter === "receive" && !l.can_receive) return false;
      if (!needle) return true;
      return [l.name, l.address_line, l.city, l.postal_code ?? ""].some((v) => v.toLowerCase().includes(needle));
    });
  }, [locations, q, filter]);

  const reviewCount = locations.filter((l) => l.needs_review).length;

  return (
    <div className="space-y-4">
      {reviewCount > 0 ? (
        <Notice tone="info">{reviewCount} {reviewCount === 1 ? "location needs" : "locations need"} review (missing postal code).</Notice>
      ) : null}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1"><Field label="Search"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, address, city or postal code" /></Field></div>
          <div className="sm:w-56">
            <Field label="Show">
              <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="review">Needs review</option>
                <option value="ship">Can ship</option>
                <option value="receive">Can receive</option>
              </Select>
            </Field>
          </div>
          <Button type="button" variant="dark" onClick={() => setCreating((c) => !c)}>{creating ? "Close form" : "New location"}</Button>
        </div>
      </Card>
      {creating ? <Card><LocationForm onDone={closeCreate} onCancel={closeCreate} /></Card> : null}
      {shown.length === 0 ? (
        <Card><p className="text-[15px] text-muted">{locations.length === 0 ? "No locations yet. Create the first one." : "No locations match this filter."}</p></Card>
      ) : (
        <div className="space-y-3">{shown.map((l) => <Row key={l.id} loc={l} authors={authors} />)}</div>
      )}
    </div>
  );
}
