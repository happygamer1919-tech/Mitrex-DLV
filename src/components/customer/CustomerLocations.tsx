"use client";

import { useState, useTransition } from "react";
import { Button, Card, Field, Input, Notice, Textarea } from "@/components/ui";
import { addCustomerLocation, updateCustomerLocation } from "@/lib/customer/location-actions";
import {
  EMPTY_LOCATION, LIMITS, locationToInput, type CustomerLocationInput, type LocationErrors,
} from "@/lib/customer/location-validate";
import { nameIsStreet } from "@/lib/address";
import type { Location } from "@/lib/types";

// R45 (DLV-041): Maria's own location forms. The add form creates the location at once; Edit opens the same fields
// for one location and Save applies at once. Status (active) and review flags are DLV's and are never offered here.

function Err({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p role="alert" className="mt-1 text-[13px] font-medium text-[#7A1F1F]">{msg}</p>;
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (b: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-[15px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="h-6 w-6 shrink-0 accent-[#020814]" />
      <span>{children}</span>
    </label>
  );
}

function LocationFields({ v, errors, set }: {
  v: CustomerLocationInput; errors: LocationErrors;
  set: <K extends keyof CustomerLocationInput>(k: K, val: CustomerLocationInput[K]) => void;
}) {
  return (
    <>
      <div>
        <Field label="Location name">
          <Input value={v.name} maxLength={LIMITS.name} autoComplete="off" onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Err msg={errors.name} />
      </div>
      <div>
        <Field label="Street address">
          <Input value={v.address_line} maxLength={LIMITS.address_line} autoComplete="off" onChange={(e) => set("address_line", e.target.value)} />
        </Field>
        <Err msg={errors.address_line} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <Field label="City">
            <Input value={v.city} maxLength={LIMITS.city} autoComplete="off" onChange={(e) => set("city", e.target.value)} />
          </Field>
          <Err msg={errors.city} />
        </div>
        <div className="min-w-0">
          <Field label="Province">
            <Input value={v.province} maxLength={2} autoComplete="off" onChange={(e) => set("province", e.target.value)} />
          </Field>
          <Err msg={errors.province} />
        </div>
        <div className="min-w-0">
          <Field label="Postal code (optional)">
            <Input value={v.postal_code} maxLength={LIMITS.postal_code} autoComplete="off" onChange={(e) => set("postal_code", e.target.value)} />
          </Field>
          <Err msg={errors.postal_code} />
        </div>
      </div>
      <fieldset>
        <legend className="mb-1 text-[13px] font-medium text-muted">What happens here</legend>
        <Check checked={v.can_ship} onChange={(b) => set("can_ship", b)}>Can ship (pickup)</Check>
        <Check checked={v.can_receive} onChange={(b) => set("can_receive", b)}>Can receive (delivery)</Check>
        <Check checked={v.requires_moffett} onChange={(b) => set("requires_moffett", b)}>Needs a Moffett</Check>
        <Err msg={errors.can_ship} />
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <Field label="Default contact name (optional)">
            <Input value={v.default_contact_name} maxLength={LIMITS.default_contact_name} autoComplete="off"
              onChange={(e) => set("default_contact_name", e.target.value)} />
          </Field>
          <Err msg={errors.default_contact_name} />
        </div>
        <div className="min-w-0">
          <Field label="Default contact phone (optional)">
            <Input type="tel" inputMode="tel" value={v.default_contact_phone} maxLength={LIMITS.default_contact_phone} autoComplete="off"
              onChange={(e) => set("default_contact_phone", e.target.value)} />
          </Field>
          <Err msg={errors.default_contact_phone} />
        </div>
      </div>
      <div>
        <Field label="Notes (optional)" hint={`At most ${LIMITS.notes} characters.`}>
          <Textarea rows={3} value={v.notes} maxLength={LIMITS.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <Err msg={errors.notes} />
      </div>
    </>
  );
}

function useLocationForm(initial: CustomerLocationInput) {
  const [v, setV] = useState<CustomerLocationInput>(initial);
  const [errors, setErrors] = useState<LocationErrors>({});
  const set = <K extends keyof CustomerLocationInput>(k: K, val: CustomerLocationInput[K]) => {
    setV((p) => ({ ...p, [k]: val }));
    setErrors((e) => ({ ...e, [k]: undefined, ...(k === "can_receive" ? { can_ship: undefined } : {}) }));
  };
  return { v, setV, errors, setErrors, set };
}

export function AddLocationForm() {
  const { v, setV, errors, setErrors, set } = useLocationForm(EMPTY_LOCATION);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      const res = await addCustomerLocation(v);
      if (res.errors) { setErrors(res.errors); setMsg({ tone: "error", text: "Check the fields marked below." }); return; }
      if (res.error) { setMsg({ tone: "error", text: res.error }); return; }
      const name = v.name.trim();
      setV(EMPTY_LOCATION);
      setErrors({});
      setMsg({ tone: "ok", text: `${name} was added. You can book with it now.` });
    });
  }

  return (
    <Card>
      <h2 id="add-location" className="mb-1 scroll-mt-4 text-[20px] font-bold">Add location</h2>
      <p className="mb-3 text-[13px] text-muted">The new location is ready for booking as soon as you add it.</p>
      <form onSubmit={submit} noValidate className="space-y-3" aria-labelledby="add-location">
        {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
        <LocationFields v={v} errors={errors} set={set} />
        <Button type="submit" disabled={pending}>{pending ? "Adding..." : "Add location"}</Button>
      </form>
    </Card>
  );
}

function Flag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-[#DCE6F5] px-3 py-1 text-[13px] font-medium">{children}</span>;
}

export function LocationCard({ location }: { location: Location }) {
  const [editing, setEditing] = useState(false);
  const { v, setV, errors, setErrors, set } = useLocationForm(locationToInput(location));
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function open() {
    setV(locationToInput(location));
    setErrors({});
    setMsg(null);
    setEditing(true);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      const res = await updateCustomerLocation(location.id, v);
      if (res.errors) { setErrors(res.errors); setMsg({ tone: "error", text: "Check the fields marked below." }); return; }
      if (res.error) { setMsg({ tone: "error", text: res.error }); return; }
      setErrors({});
      setEditing(false);
      setMsg({ tone: "ok", text: "Saved." });
    });
  }

  const contact = [location.default_contact_name, location.default_contact_phone].filter(Boolean).join(", ");

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-bold break-words">{location.name}</h2>
          <p className="text-[15px] text-muted break-words">
            {nameIsStreet(location) ? "" : `${location.address_line}, `}{location.city}, {location.province}
            {location.postal_code ? ` ${location.postal_code}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {location.can_ship ? <Flag>Can ship</Flag> : null}
          {location.can_receive ? <Flag>Can receive</Flag> : null}
          {location.requires_moffett ? <Flag>Moffett</Flag> : null}
        </div>
      </div>
      <p className="mt-2 text-[13px] text-muted break-words">Default contact: {contact || "None saved"}</p>
      {location.notes ? <p className="mt-1 text-[13px] text-muted break-words">Notes: {location.notes}</p> : null}
      {msg && !editing ? (
        <p role={msg.tone === "error" ? "alert" : "status"}
          className={`mt-2 text-[13px] font-medium ${msg.tone === "error" ? "text-[#7A1F1F]" : "text-[#12875A]"}`}>
          {msg.text}
        </p>
      ) : null}
      {editing ? (
        <form onSubmit={submit} noValidate className="mt-4 space-y-3 border-t border-line pt-4"
          aria-label={`Edit ${location.name}`}>
          {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
          <LocationFields v={v} errors={errors} set={set} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="dark" disabled={pending}>{pending ? "Saving..." : "Save changes"}</Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => { setEditing(false); setMsg(null); }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="mt-3">
          <Button type="button" variant="ghost" aria-label={`Edit ${location.name}`} onClick={open}>Edit</Button>
        </div>
      )}
    </Card>
  );
}
