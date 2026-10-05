import { Shell } from "@/components/Shell";
import { Card, Notice, PageTitle } from "@/components/ui";
import { ActionForm } from "@/components/admin/ActionForm";
import { InviteForm } from "@/components/admin/InviteForm";
import { NameManager } from "@/components/admin/NameManager";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";
import { createCustomer, renameCustomer } from "@/lib/admin/org-actions";
import { removeUser } from "@/lib/admin/user-actions";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  staff_admin: "Staff admin", staff_csr: "Staff CSR", customer: "Customer",
  carrier_owner: "Carrier owner", carrier_driver: "Carrier driver",
};

export default async function UsersPage() {
  const me = await requireAdmin();
  const supabase = await createClient();
  const [usersRes, customersRes, carriersRes] = await Promise.all([
    supabase.from("profiles").select("id,email,full_name,role,customer_id,carrier_id").order("email"),
    supabase.from("customers").select("id,name").order("name"),
    supabase.from("carriers").select("id,name,is_active").order("name"),
  ]);
  const users = (usersRes.data ?? []) as Profile[];
  const customers = (customersRes.data ?? []) as { id: string; name: string }[];
  const carriers = (carriersRes.data ?? []) as { id: string; name: string; is_active: boolean }[];
  const error = usersRes.error ?? customersRes.error ?? carriersRes.error;
  const cName = new Map(customers.map((c) => [c.id, c.name]));
  const kName = new Map(carriers.map((c) => [c.id, c.name]));

  return (
    <Shell profile={me}>
      <PageTitle>Users</PageTitle>
      {error ? <div className="mb-4"><Notice tone="error">Could not load users: {error.message}</Notice></div> : null}
      <div className="space-y-6">
        <InviteForm customers={customers} carriers={carriers} />

        <Card>
          <h2 className="mb-3 text-[20px] font-bold">All users ({users.length})</h2>
          {users.length === 0 ? (
            <p className="text-[15px] text-muted">No users yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {users.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[16px] font-bold">{u.full_name || u.email}</p>
                    <p className="break-words text-[13px] text-muted">{u.email}</p>
                    <p className="text-[13px]">
                      {ROLE_LABEL[u.role] ?? u.role}
                      {u.customer_id ? `, ${cName.get(u.customer_id) ?? "Unknown customer"}` : ""}
                      {u.carrier_id ? `, ${kName.get(u.carrier_id) ?? "Unknown carrier"}` : ""}
                    </p>
                  </div>
                  {u.id === me.id ? (
                    <span className="text-[13px] text-muted">You</span>
                  ) : (
                    <ActionForm
                      action={removeUser} fields={{ id: u.id }} label="Remove" variant="danger"
                      confirm={`Remove ${u.email}? They lose access immediately.`}
                      confirmLabel="Yes, remove" pendingLabel="Removing..." showOk={false}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <section>
          <h2 className="mb-3 text-[20px] font-bold">Customers</h2>
          <NameManager noun="customer" items={customers} createAction={createCustomer} renameAction={renameCustomer} />
        </section>
      </div>
    </Shell>
  );
}
