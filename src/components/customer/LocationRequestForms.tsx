"use client";

import { useState, useTransition } from "react";
import { Button, Card, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import {
  requestAddressChange, requestNewLocation,
  type ChangeLocationInput, type NewLocationInput,
} from "@/lib/customer/actions";
import type { Location } from "@/lib/types";

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

const NEW_EMPTY: NewLocationInput = {
  name: "", address_line: "", city: "", province: "ON", postal_code: "",
  can_ship: false, can_receive: true, requires_moffett: false,
  contact_name: "", contact_phone: "", notes: "",
};

export function NewLocationForm() {
  const [v, setV] = useState<NewLocationInput>(NEW_EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof NewLocationInput>(k: K, val: NewLocationInput[K]) => {
    setV((p) => ({ ...p, [k]: val }));
    setErrors((e) => ({ ...e, [k]: "" }));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      const res = await requestNewLocation(v);
      if (res.errors) { setErrors(res.errors); return; }
      if (res.error) { setMsg({ tone: "error", text: res.error }); return; }
      setV(NEW_EMPTY);
      setErrors({});
      setMsg({ tone: "ok", text: "Request sent. DLV will review it." });
    });
  }

  return (
    <Card>
      <h2 className="mb-3 text-[20px] font-bold">Request new location</h2>
      <form onSubmit={submit} noValidate className="space-y-3">
        {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
        <div>
          <Field label="Location name"><Input value={v.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Err msg={errors.name} />
        </div>
        <div>
          <Field label="Street address"><Input value={v.address_line} onChange={(e) => set("address_line", e.target.value)} /></Field>
          <Err msg={errors.address_line} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Field label="City"><Input value={v.city} onChange={(e) => set("city", e.target.value)} /></Field>
            <Err msg={errors.city} />
          </div>
          <div>
            <Field label="Province"><Input value={v.province} onChange={(e) => set("province", e.target.value)} /></Field>
            <Err msg={errors.province} />
          </div>
          <Field label="Postal code (optional)">
            <Input value={v.postal_code} onChange={(e) => set("postal_code", e.target.value)} />
          </Field>
        </div>
        <div>
          <Check checked={v.can_ship} onChange={(b) => set("can_ship", b)}>Can ship (pickup)</Check>
          <Check checked={v.can_receive} onChange={(b) => set("can_receive", b)}>Can receive (delivery)</Check>
          <Check checked={v.requires_moffett} onChange={(b) => set("requires_moffett", b)}>Requires a Moffett</Check>
          <Err msg={errors.can_ship} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Contact name (optional)">
            <Input value={v.contact_name} onChange={(e) => set("contact_name", e.target.value)} />
          </Field>
          <Field label="Contact phone (optional)">
            <Input type="tel" inputMode="tel" value={v.contact_phone} onChange={(e) => set("contact_phone", e.target.value)} />
          </Field>
        </div>
        <Field label="Notes (optional)">
          <Textarea rows={3} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <Button type="submit" disabled={pending}>{pending ? "Sending..." : "Send request"}</Button>
      </form>
    </Card>
  );
}

const CHANGE_EMPTY: ChangeLocationInput = {
  location_id: "", name: "", address_line: "", city: "", province: "", postal_code: "", notes: "",
};

export function ChangeRequestForm({ locations }: { locations: Location[] }) {
  const [v, setV] = useState<ChangeLocationInput>(CHANGE_EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const current = locations.find((l) => l.id === v.location_id);
  const set = <K extends keyof ChangeLocationInput>(k: K, val: ChangeLocationInput[K]) => {
    setV((p) => ({ ...p, [k]: val }));
    setErrors((e) => ({ ...e, [k]: "", fields: "" }));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      const res = await requestAddressChange(v);
      if (res.errors) { setErrors(res.errors); return; }
      if (res.error) { setMsg({ tone: "error", text: res.error }); return; }
      setV(CHANGE_EMPTY);
      setErrors({});
      setMsg({ tone: "ok", text: "Request sent. DLV will review it." });
    });
  }

  return (
    <Card>
      <h2 className="mb-1 text-[20px] font-bold">Request address change</h2>
      <p className="mb-3 text-[13px] text-muted">Fill in only the fields that should change.</p>
      <form onSubmit={submit} noValidate className="space-y-3">
        {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
        <div>
          <Field label="Location">
            <Select value={v.location_id} onChange={(e) => set("location_id", e.target.value)}>
              <option value="">Select a location</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Err msg={errors.location_id} />
        </div>
        <Field label="New name">
          <Input value={v.name} placeholder={current?.name ?? ""} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="New street address">
          <Input value={v.address_line} placeholder={current?.address_line ?? ""} onChange={(e) => set("address_line", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="New city">
            <Input value={v.city} placeholder={current?.city ?? ""} onChange={(e) => set("city", e.target.value)} />
          </Field>
          <Field label="New province">
            <Input value={v.province} placeholder={current?.province ?? ""} onChange={(e) => set("province", e.target.value)} />
          </Field>
          <Field label="New postal code">
            <Input value={v.postal_code} placeholder={current?.postal_code ?? ""} onChange={(e) => set("postal_code", e.target.value)} />
          </Field>
        </div>
        <Err msg={errors.fields} />
        <Field label="Reason or notes (optional)">
          <Textarea rows={3} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <Button type="submit" disabled={pending}>{pending ? "Sending..." : "Send request"}</Button>
      </form>
    </Card>
  );
}
