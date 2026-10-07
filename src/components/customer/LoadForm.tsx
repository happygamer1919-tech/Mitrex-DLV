"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { createLoad, updateLoad } from "@/lib/customer/actions";
import { failure, goToLogin, withTimeout } from "@/lib/client/action-guard";
import { MAX_TRUCKS, parseQuantityText } from "@/lib/customer/bulk";
import {
  EQUIPMENT_SIZES, validateLoad, type FieldErrors, type LoadFormValues,
} from "@/lib/customer/validate";
import { fmtDateEt } from "@/lib/format";
import type { LastContacts } from "@/lib/customer/requestAgain";
import type { Location, Timing } from "@/lib/types";

type Props = {
  mode: "create" | "edit";
  loadId?: string;
  locations: Location[];
  initial: LoadFormValues;
  today: string;
  lastContacts?: LastContacts; // most recent contact per location (new booking only)
  copiedFrom?: string | null; // load number a Request again was copied from
};

function Err({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p role="alert" className="mt-1 text-[13px] font-medium text-[#7A1F1F]">{msg}</p>;
}

function TimingSwitch({ value, onChange, name }: { value: Timing; onChange: (t: Timing) => void; name: string }) {
  const opts: { v: Timing; label: string }[] = [
    { v: "appointment", label: "Appointment" },
    { v: "window", label: "Time window" },
  ];
  return (
    <div role="radiogroup" aria-label={`${name} timing`} className="flex gap-2">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={`min-h-[48px] flex-1 rounded-full border px-4 text-[15px] font-bold cursor-pointer ${
            value === o.v ? "border-ink bg-ink text-white" : "border-line bg-white text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CheckRow({ checked, onChange, children, disabled = false }:
  { checked: boolean; onChange: (b: boolean) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-[15px]">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-6 w-6 shrink-0 accent-[#020814]"
      />
      <span>{children}</span>
    </label>
  );
}

const NO_LAST: LastContacts = { pickup: {}, delivery: {} };

export function LoadForm({ mode, loadId, locations, initial, today, lastContacts = NO_LAST, copiedFrom = null }: Props) {
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [v, setV] = useState<LoadFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false); // own flag: a transition stays pending while Next holds the action
  const [qty, setQty] = useState("1"); // how many trucks (new booking only)
  const inflight = useRef(false); // synchronous double submit lock

  const parsedQty = parseQuantityText(qty);
  const trucks = "value" in parsedQty ? parsedQty.value : 1;

  function stepQty(delta: number) {
    const cur = "value" in parsedQty ? parsedQty.value : 1;
    setQty(String(Math.min(MAX_TRUCKS, Math.max(1, cur + delta))));
    setErrors((e) => ({ ...e, quantity: undefined }));
  }

  const shippers = useMemo(() => locations.filter((l) => l.can_ship && l.is_active), [locations]);
  const receivers = useMemo(() => locations.filter((l) => l.can_receive && l.is_active), [locations]);
  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const pickup = byId.get(v.pickup_location_id);
  const delivery = byId.get(v.delivery_location_id);
  const moffettLocked = Boolean(pickup?.requires_moffett || delivery?.requires_moffett);
  const moffettOn = moffettLocked || v.moffett;
  const moffettWhy = [pickup?.requires_moffett ? pickup.name : null, delivery?.requires_moffett ? delivery.name : null]
    .filter(Boolean).join(" and ");

  function set<K extends keyof LoadFormValues>(key: K, value: LoadFormValues[K]) {
    setV((p) => ({ ...p, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function pickLocation(side: "pickup" | "delivery", id: string) {
    const loc = byId.get(id);
    setV((p) => ({
      ...p,
      [`${side}_location_id`]: id,
      [`${side}_contact_name`]: loc?.default_contact_name ?? "",
      [`${side}_contact_phone`]: loc?.default_contact_phone ?? "",
      [`save_${side}_default`]: false,
    }));
    setErrors((e) => ({
      ...e,
      [`${side}_location_id`]: undefined,
      [`${side}_contact_name`]: undefined,
      [`${side}_contact_phone`]: undefined,
      delivery_location_id: side === "delivery" ? undefined : e.delivery_location_id,
    }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const payload: LoadFormValues = { ...v, moffett: moffettOn };
    const found = validateLoad(payload);
    if (mode === "create" && "error" in parsedQty) found.quantity = parsedQty.error;
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError("Please fix the highlighted fields.");
      return;
    }
    if (inflight.current) return;
    inflight.current = true;
    setPending(true);
    void (async () => {
      try {
        const res = await withTimeout(
          mode === "edit" && loadId ? updateLoad(loadId, payload) : createLoad(payload, trucks),
        );
        // On success the action redirects, so a returned value is always a failure.
        if (res?.fieldErrors) setErrors(res.fieldErrors);
        setFormError(res?.error ?? (res?.fieldErrors ? "Please fix the highlighted fields." : null));
      } catch (e) {
        const f = failure(e);
        if (f.sessionExpired) {
          goToLogin();
          return;
        }
        setFormError(f.message);
      } finally {
        inflight.current = false;
        setPending(false);
      }
    })();
  }

  function slot(side: "pickup" | "delivery", title: string) {
    const timing = v[`${side}_timing`];
    const dateKey = `${side}_date` as const;
    const startKey = `${side}_time_start` as const;
    const endKey = `${side}_time_end` as const;
    return (
      <div className="mt-4 space-y-3">
        <p className="text-[13px] font-medium text-muted">{title} timing</p>
        <TimingSwitch value={timing} onChange={(t) => set(`${side}_timing`, t)} name={title} />
        <Err msg={errors[`${side}_timing`]} />
        <Field label={`${title} date`}>
          <Input type="date" min={today} value={v[dateKey]} aria-invalid={Boolean(errors[dateKey])}
            onChange={(e) => set(dateKey, e.target.value)} />
        </Field>
        <Err msg={errors[dateKey]} />
        {timing === "appointment" ? (
          <>
            <Field label="Appointment time (ET)">
              <Input type="time" value={v[startKey]} aria-invalid={Boolean(errors[startKey])}
                onChange={(e) => set(startKey, e.target.value)} />
            </Field>
            <Err msg={errors[startKey]} />
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Field label="Window from (ET)">
                <Input type="time" value={v[startKey]} aria-invalid={Boolean(errors[startKey])}
                  onChange={(e) => set(startKey, e.target.value)} />
              </Field>
              <Err msg={errors[startKey]} />
            </div>
            <div>
              <Field label="Window to (ET)">
                <Input type="time" value={v[endKey]} aria-invalid={Boolean(errors[endKey])}
                  onChange={(e) => set(endKey, e.target.value)} />
              </Field>
              <Err msg={errors[endKey]} />
            </div>
          </div>
        )}
      </div>
    );
  }

  function contact(side: "pickup" | "delivery") {
    const nameKey = `${side}_contact_name` as const;
    const phoneKey = `${side}_contact_phone` as const;
    const saveKey = `save_${side}_default` as const;
    const locId = v[`${side}_location_id`];
    const loc = byId.get(locId);
    const last = mode === "create" && locId ? lastContacts[side][locId] : undefined;
    const same = last ? v[nameKey].trim() === last.name && v[phoneKey].trim() === last.phone : false;
    const hasDefault = Boolean(loc?.default_contact_name || loc?.default_contact_phone);
    const when = last ? `${last.label}, ${fmtDateEt(last.createdAt)}` : "";
    return (
      <div className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Field label="Contact name">
              <Input value={v[nameKey]} autoComplete="off" aria-invalid={Boolean(errors[nameKey])}
                onChange={(e) => set(nameKey, e.target.value)} />
            </Field>
            <Err msg={errors[nameKey]} />
          </div>
          <div>
            <Field label="Contact phone">
              <Input type="tel" inputMode="tel" value={v[phoneKey]} autoComplete="off"
                aria-invalid={Boolean(errors[phoneKey])} onChange={(e) => set(phoneKey, e.target.value)} />
            </Field>
            <Err msg={errors[phoneKey]} />
          </div>
        </div>
        {mode === "create" ? (
          <div aria-live="polite" data-testid={`${side}-last-contact`} className="text-[13px] text-muted">
            {last ? (
              same
                ? <p data-testid={`${side}-last-same`}>Same as last time ({when})</p>
                : <p data-testid={`${side}-last-line`}>Last contact at {loc?.name}: {last.name}, {last.phone} ({when})</p>
            ) : locId && hasDefault ? (
              <p data-testid={`${side}-last-none`}>No earlier load here. Using the saved default contact.</p>
            ) : null}
          </div>
        ) : null}
        {last && !same ? (
          <button type="button" data-testid={`${side}-use-last`}
            onClick={() => {
              setV((p) => ({ ...p, [nameKey]: last.name, [phoneKey]: last.phone }));
              setErrors((e) => ({ ...e, [nameKey]: undefined, [phoneKey]: undefined }));
            }}
            className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-line bg-white px-4 text-[15px] font-bold text-ink cursor-pointer">
            Use last contact
          </button>
        ) : null}
        <CheckRow checked={v[saveKey]} disabled={!locId} onChange={(b) => set(saveKey, b)}>
          Save as default for this location
        </CheckRow>
      </div>
    );
  }

  if (shippers.length === 0 || receivers.length === 0) {
    return (
      <Notice tone="info">
        There is no location available to {shippers.length === 0 ? "ship from" : "deliver to"} yet.
        Request a new location on the <Link href="/locations" className="font-bold underline">Locations</Link> page.
      </Notice>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {copiedFrom && noticeOpen ? (
        <Notice tone="info">
          <div className="flex items-center justify-between gap-3">
            <span data-testid="copied-notice">Copied from {copiedFrom}. Choose the new dates and times.</span>
            <button type="button" aria-label="Dismiss notice" onClick={() => setNoticeOpen(false)}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full border border-line bg-white px-3 text-[15px] font-bold text-ink cursor-pointer">
              Dismiss
            </button>
          </div>
        </Notice>
      ) : null}
      {formError ? <Notice tone="error">{formError}</Notice> : null}

      <Card>
        <h2 className="mb-3 text-[20px] font-bold">Pickup</h2>
        <Field label="Pickup location">
          <Select value={v.pickup_location_id} aria-invalid={Boolean(errors.pickup_location_id)}
            onChange={(e) => pickLocation("pickup", e.target.value)}>
            <option value="">Select pickup location</option>
            {shippers.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.city})</option>)}
          </Select>
        </Field>
        <Err msg={errors.pickup_location_id} />
        {contact("pickup")}
        {slot("pickup", "Pickup")}
      </Card>

      <Card>
        <h2 className="mb-3 text-[20px] font-bold">Delivery</h2>
        <Field label="Delivery location">
          <Select value={v.delivery_location_id} aria-invalid={Boolean(errors.delivery_location_id)}
            onChange={(e) => pickLocation("delivery", e.target.value)}>
            <option value="">Select delivery location</option>
            {receivers.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.city})</option>)}
          </Select>
        </Field>
        <Err msg={errors.delivery_location_id} />
        {contact("delivery")}
        {slot("delivery", "Delivery")}
      </Card>

      <Card>
        <h2 className="mb-3 text-[20px] font-bold">Equipment</h2>
        <div role="radiogroup" aria-label="Equipment size" className="grid grid-cols-3 gap-2">
          {EQUIPMENT_SIZES.map((s) => {
            const on = v.equipment_size === String(s);
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set("equipment_size", String(s))}
                className={`min-h-[56px] rounded-[16px] border text-[20px] font-bold cursor-pointer ${
                  on ? "border-ink bg-ink text-white" : "border-line bg-white text-ink"
                }`}
              >
                {s}
                <span className="ml-0.5 text-[13px] font-medium">ft</span>
              </button>
            );
          })}
        </div>
        <Err msg={errors.equipment_size} />
        <div className="mt-3">
          <CheckRow checked={moffettOn} disabled={moffettLocked} onChange={(b) => set("moffett", b)}>
            Moffett (forklift on truck) needed
          </CheckRow>
          {moffettLocked ? (
            <p className="text-[13px] text-muted">Required: {moffettWhy} needs a Moffett for unloading or loading.</p>
          ) : null}
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-[20px] font-bold">Details</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Field label="Weight (lbs, optional)">
              <Input inputMode="decimal" value={v.weight_lbs} aria-invalid={Boolean(errors.weight_lbs)}
                onChange={(e) => set("weight_lbs", e.target.value)} />
            </Field>
            <Err msg={errors.weight_lbs} />
          </div>
          <div>
            <Field label="Pieces (optional)">
              <Input inputMode="numeric" value={v.pieces} aria-invalid={Boolean(errors.pieces)}
                onChange={(e) => set("pieces", e.target.value)} />
            </Field>
            <Err msg={errors.pieces} />
          </div>
          <Field label="PO number (optional)">
            <Input value={v.po_number} onChange={(e) => set("po_number", e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Notes (optional)">
            <Textarea rows={3} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <Err msg={errors.notes} />
        </div>
      </Card>

      {mode === "create" ? (
        <Card>
          <h2 className="mb-3 text-[20px] font-bold">Trucks</h2>
          <label htmlFor="truck-qty" className="mb-1 block text-[13px] font-medium text-muted">How many trucks?</label>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Fewer trucks" disabled={pending || ("value" in parsedQty && trucks <= 1)}
              onClick={() => stepQty(-1)}
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-white text-[24px] font-bold text-ink disabled:opacity-50 cursor-pointer">
              {"\u2212"}
            </button>
            <input id="truck-qty" type="text" inputMode="numeric" autoComplete="off" value={qty} disabled={pending}
              aria-invalid={Boolean(errors.quantity)} aria-describedby="truck-qty-help"
              onChange={(e) => { setQty(e.target.value); if (errors.quantity) setErrors((x) => ({ ...x, quantity: undefined })); }}
              className="min-h-[48px] w-20 rounded-[12px] border border-line bg-white px-3 text-center text-[20px] font-bold text-ink" />
            <button type="button" aria-label="More trucks" disabled={pending || trucks >= MAX_TRUCKS}
              onClick={() => stepQty(1)}
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-white text-[24px] font-bold text-ink disabled:opacity-50 cursor-pointer">
              +
            </button>
          </div>
          <Err msg={errors.quantity} />
          <p id="truck-qty-help" className="mt-2 text-[13px] text-muted">Details above apply to every truck.</p>
          {trucks > 1 && !errors.quantity ? (
            <p className="mt-1 text-[15px] font-medium">
              This creates {trucks} separate loads, one per truck. Each gets its own load number and status.
            </p>
          ) : null}
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" big disabled={pending} className="w-full sm:w-auto">
          {pending ? "Saving..." : mode === "edit" ? "Save changes" : trucks > 1 ? `Request ${trucks} loads` : "Request load"}
        </Button>
        {mode === "edit" && loadId ? (
          <Link href={`/loads/${loadId}`}
            className="inline-flex min-h-[56px] w-full items-center justify-center rounded-full border border-line px-5 text-[18px] font-bold sm:w-auto">
            Back to load
          </Link>
        ) : null}
      </div>
    </form>
  );
}
