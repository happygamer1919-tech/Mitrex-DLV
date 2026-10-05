import { Shell } from "@/components/Shell";
import { Card, Notice, PageTitle } from "@/components/ui";
import { ActionForm } from "@/components/admin/ActionForm";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime } from "@/lib/format";
import type { LocationRequest } from "@/lib/types";
import { approveRequest, rejectRequest } from "@/lib/admin/location-actions";

export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = {
  name: "Name", address_line: "Address", city: "City", province: "Province", postal_code: "Postal code",
  can_ship: "Can ship", can_receive: "Can receive", requires_moffett: "Requires Moffett",
  default_contact_name: "Contact name", default_contact_phone: "Contact phone", notes: "Notes",
};

function show(v: unknown): string {
  if (v === true) return "Yes";
  if (v === false) return "No";
  if (v === null || v === undefined || v === "") return "Empty";
  return String(v);
}

function Payload({ payload }: { payload: Record<string, unknown> }) {
  const keys = Object.keys(payload);
  if (keys.length === 0) return <p className="text-[15px] text-muted">No details.</p>;
  return (
    <dl className="divide-y divide-line">
      {keys.map((k) => (
        <div key={k} className="py-1.5 sm:grid sm:grid-cols-[160px_1fr] sm:gap-3">
          <dt className="text-[13px] font-medium text-muted">{LABELS[k] ?? k.replace(/_/g, " ")}</dt>
          <dd className="break-words text-[15px]">{show(payload[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function RequestsPage() {
  const profile = await requireStaff();
  const supabase = await createClient();
  const [pendingRes, doneRes] = await Promise.all([
    supabase.from("location_requests").select("*").eq("status", "pending").order("created_at"),
    supabase.from("location_requests").select("*").neq("status", "pending").order("created_at", { ascending: false }).limit(15),
  ]);
  const pending = (pendingRes.data ?? []) as LocationRequest[];
  const done = (doneRes.data ?? []) as LocationRequest[];
  const error = pendingRes.error ?? doneRes.error;

  const userIds = [...new Set([...pending, ...done].map((r) => r.requested_by))];
  const locIds = [...new Set([...pending, ...done].map((r) => r.location_id).filter((v): v is string => !!v))];
  const emails = new Map<string, string>();
  const locNames = new Map<string, string>();
  if (userIds.length > 0) {
    const { data } = await supabase.from("profiles").select("id,email").in("id", userIds);
    ((data ?? []) as { id: string; email: string }[]).forEach((p) => emails.set(p.id, p.email));
  }
  if (locIds.length > 0) {
    const { data } = await supabase.from("locations").select("id,name").in("id", locIds);
    ((data ?? []) as { id: string; name: string }[]).forEach((l) => locNames.set(l.id, l.name));
  }

  return (
    <Shell profile={profile}>
      <PageTitle>Location requests</PageTitle>
      {error ? <div className="mb-4"><Notice tone="error">Could not load requests: {error.message}</Notice></div> : null}

      <h2 className="mb-3 text-[20px] font-bold">Pending ({pending.length})</h2>
      {pending.length === 0 ? (
        <Card><p className="text-[15px] text-muted">No pending requests.</p></Card>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => (
            <Card key={r.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[#DCE6F5] px-3 py-1 text-[13px] font-medium">
                  {r.kind === "new" ? "New location" : "Change to a location"}
                </span>
                <span className="text-[13px] text-muted">
                  {emails.get(r.requested_by) ?? "Unknown user"}, {fmtDateTime(r.created_at)}
                </span>
              </div>
              {r.kind === "change" && r.location_id ? (
                <p className="mb-2 text-[15px]">Existing location: <span className="font-bold">{locNames.get(r.location_id) ?? "Unknown"}</span></p>
              ) : null}
              <Payload payload={r.payload} />
              <div className="mt-3 flex flex-wrap items-start gap-2">
                <ActionForm action={approveRequest} fields={{ id: r.id }} label="Approve" pendingLabel="Approving..." variant="neon" />
                <ActionForm
                  action={rejectRequest} fields={{ id: r.id }} label="Reject" pendingLabel="Rejecting..." variant="danger"
                  confirm="Reject this request?" confirmLabel="Yes, reject"
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-8 text-[20px] font-bold">Recently reviewed</h2>
      {done.length === 0 ? (
        <Card><p className="text-[15px] text-muted">Nothing reviewed yet.</p></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {done.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-[13px] font-medium ${r.status === "approved" ? "bg-[#CFF5DE]" : "bg-[#F7D9D9] text-[#7A1F1F]"}`}>
                    {r.status === "approved" ? "Approved" : "Rejected"}
                  </span>
                  <span className="text-[15px] font-bold">{show(r.payload.name ?? (r.location_id ? locNames.get(r.location_id) : null))}</span>
                  <span className="text-[13px] text-muted">
                    {r.kind === "new" ? "New" : "Change"}, {emails.get(r.requested_by) ?? "Unknown user"}, {fmtDateTime(r.created_at)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Shell>
  );
}
