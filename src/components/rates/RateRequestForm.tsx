"use client";
import { useActionState, useState } from "react";
import { Button, Card, Field, Input, Notice, Textarea } from "@/components/ui";
import { createRateRequest, type RateFormState } from "@/lib/rates/actions";
import { DIMS_MAX, EMPTY_RATE_FORM, NOTES_MAX, RATE_SIZES, type RateFields, type RateFormValues } from "@/lib/rates/validate";

function Err({ id, msg }: { id: string; msg?: string }) {
  return msg ? <p id={id} role="alert" className="mt-1 text-[14px] font-medium text-[#7A1F1F]">{msg}</p> : null;
}

// Customers only. Controlled fields, so a refused submit keeps what was typed (an uncontrolled form is reset after
// every action). Every rule is checked by the server action (src/lib/rates/validate.ts) and again by the database.
export function RateRequestForm() {
  const [state, action, pending] = useActionState<RateFormState, FormData>(createRateRequest, {});
  const [v, setV] = useState<RateFormValues>(EMPTY_RATE_FORM);
  const set = (k: RateFields, value: string) => setV((p) => ({ ...p, [k]: value }));
  const errors = state.fieldErrors ?? {};
  const e = (k: RateFields) => errors[k];
  const ad = (k: RateFields) => ({ "aria-invalid": Boolean(e(k)), "aria-describedby": e(k) ? `rr-${k}-err` : undefined });

  return (
    <form
      action={action}
      aria-label="Request a rate"
      noValidate
      className="space-y-4"
    >
      <Card>
        <h2 className="mb-3 text-[20px] font-bold">Pickup</h2>
        <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <div>
            <Field label="Pickup city"><Input name="pickup_city" value={v.pickup_city} maxLength={120} autoComplete="off" onChange={(ev) => set("pickup_city", ev.target.value)} {...ad("pickup_city")} /></Field>
            <Err id="rr-pickup_city-err" msg={e("pickup_city")} />
          </div>
          <div>
            <Field label="Pickup state"><Input name="pickup_state" value={v.pickup_state} maxLength={2} autoCapitalize="characters" autoComplete="off" placeholder="ON" onChange={(ev) => set("pickup_state", ev.target.value.toUpperCase())} {...ad("pickup_state")} /></Field>
            <Err id="rr-pickup_state-err" msg={e("pickup_state")} />
          </div>
        </div>
      </Card>
      <Card>
        <h2 className="mb-3 text-[20px] font-bold">Delivery</h2>
        <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <div>
            <Field label="Delivery city"><Input name="delivery_city" value={v.delivery_city} maxLength={120} autoComplete="off" onChange={(ev) => set("delivery_city", ev.target.value)} {...ad("delivery_city")} /></Field>
            <Err id="rr-delivery_city-err" msg={e("delivery_city")} />
          </div>
          <div>
            <Field label="Delivery state"><Input name="delivery_state" value={v.delivery_state} maxLength={2} autoCapitalize="characters" autoComplete="off" placeholder="NY" onChange={(ev) => set("delivery_state", ev.target.value.toUpperCase())} {...ad("delivery_state")} /></Field>
            <Err id="rr-delivery_state-err" msg={e("delivery_state")} />
          </div>
        </div>
      </Card>
      <Card>
        <h2 className="mb-3 text-[20px] font-bold">Equipment</h2>
        <input type="hidden" name="equipment_size" value={v.equipment_size} />
        <div role="radiogroup" aria-label="Equipment size" className="grid grid-cols-3 gap-2">
          {RATE_SIZES.map((s) => {
            const on = v.equipment_size === String(s);
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set("equipment_size", String(s))}
                className={`min-h-[56px] rounded-[16px] border text-[20px] font-bold cursor-pointer ${on ? "border-ink bg-ink text-white" : "border-line bg-white text-ink"}`}
              >
                {s}<span className="ml-0.5 text-[13px] font-medium">ft</span>
              </button>
            );
          })}
        </div>
        <Err id="rr-equipment_size-err" msg={e("equipment_size")} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Field label="Weight in lbs (optional)"><Input name="weight_lbs" value={v.weight_lbs} inputMode="numeric" autoComplete="off" onChange={(ev) => set("weight_lbs", ev.target.value)} {...ad("weight_lbs")} /></Field>
            <Err id="rr-weight_lbs-err" msg={e("weight_lbs")} />
          </div>
          <div>
            <Field label="Dimensions (optional)"><Input name="dims" value={v.dims} maxLength={DIMS_MAX + 50} autoComplete="off" placeholder="for example 40 x 8 x 6 ft" onChange={(ev) => set("dims", ev.target.value)} {...ad("dims")} /></Field>
            <Err id="rr-dims-err" msg={e("dims")} />
          </div>
        </div>
        <div className="mt-3">
          <Field label="Notes (optional)"><Textarea name="notes" value={v.notes} rows={3} maxLength={NOTES_MAX + 200} onChange={(ev) => set("notes", ev.target.value)} {...ad("notes")} /></Field>
          <Err id="rr-notes-err" msg={e("notes")} />
        </div>
      </Card>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      <Button type="submit" variant="dark" big disabled={pending} className="w-full sm:w-auto">{pending ? "Sending..." : "Request a rate"}</Button>
    </form>
  );
}
