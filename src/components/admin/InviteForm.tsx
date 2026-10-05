"use client";
import { useActionState, useEffect, useState } from "react";
import { Button, Card, Field, Input, Notice, Select } from "@/components/ui";
import { inviteUser } from "@/lib/admin/user-actions";
import type { ActionState } from "@/lib/admin/state";

const ROLE_LABEL: Record<string, string> = {
  staff_admin: "Staff admin",
  staff_csr: "Staff CSR",
  customer: "Customer",
  carrier_owner: "Carrier owner",
  carrier_driver: "Carrier driver",
};

export function InviteForm({
  customers, carriers,
}: { customers: { id: string; name: string }[]; carriers: { id: string; name: string; is_active: boolean }[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(inviteUser, {});
  const [role, setRole] = useState("staff_csr");
  const [key, setKey] = useState(0);
  useEffect(() => { if (state.ok) { setKey((k) => k + 1); setRole("staff_csr"); } }, [state.ok]);
  const needsCustomer = role === "customer";
  const needsCarrier = role === "carrier_owner" || role === "carrier_driver";

  return (
    <Card>
      <h2 className="mb-3 text-[20px] font-bold">Add a user</h2>
      <form key={key} action={action} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email"><Input name="email" type="email" required autoComplete="off" /></Field>
          <Field label="Full name"><Input name="full_name" required maxLength={120} /></Field>
          <Field label="Role">
            <Select name="role" value={role} onChange={(e) => setRole(e.target.value)}>
              {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          {needsCustomer ? (
            <Field label="Customer">
              <Select name="customer_id" required defaultValue="">
                <option value="" disabled>Choose a customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          ) : null}
          {needsCarrier ? (
            <Field label="Carrier">
              <Select name="carrier_id" required defaultValue="">
                <option value="" disabled>Choose a carrier</option>
                {carriers.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          ) : null}
        </div>
        <p className="text-[13px] text-muted">
          The user signs in from the login page with this email (a sign-in link is emailed to them). No invitation email is sent.
        </p>
        <Button type="submit" disabled={pending}>{pending ? "Adding..." : "Add user"}</Button>
        {state.error ? <Notice tone="error">{state.error}</Notice> : null}
        {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
      </form>
    </Card>
  );
}
