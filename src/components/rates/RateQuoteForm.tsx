"use client";
import { useActionState, useState } from "react";
import { Button, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import type { ActionState } from "@/lib/admin/state";
import { quoteRateRequest } from "@/lib/rates/actions";
import { NOTES_MAX } from "@/lib/rates/validate";

// Staff only. Controlled fields, so a refused submit keeps what was typed. Prefilled with the existing rate when staff
// correct one.
export function RateQuoteForm({ id, existing }: { id: string; existing: { amount: string; currency: string; notes: string; validUntil: string } | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(quoteRateRequest, {});
  const [amount, setAmount] = useState(existing?.amount ?? "");
  const [currency, setCurrency] = useState(existing?.currency ?? "CAD");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [validUntil, setValidUntil] = useState(existing?.validUntil ?? "");
  return (
    <form action={action} aria-label={existing ? "Correct the rate" : "Enter the rate"} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Amount" hint="Numbers only, up to two decimals.">
          <Input name="amount" value={amount} inputMode="decimal" autoComplete="off" required onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Currency">
          <Select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </Select>
        </Field>
        <Field label="Valid until (optional)">
          <Input name="valid_until" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes for the customer (optional)">
        <Textarea name="notes" rows={3} value={notes} maxLength={NOTES_MAX + 200} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Button type="submit" variant="dark" disabled={pending}>{pending ? "Saving..." : existing ? "Correct the rate" : "Save rate"}</Button>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="ok"><span data-testid="quote-ok">{state.ok}</span></Notice> : null}
    </form>
  );
}
