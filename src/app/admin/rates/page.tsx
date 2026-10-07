import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Shell } from "@/components/Shell";
import { Notice, PageTitle } from "@/components/ui";
import { RateStatusBadge } from "@/components/rates/RateStatusBadge";
import { requireStaff } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { fmtMoney, rateLane, type RateRequest } from "@/lib/rates/validate";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Row = RateRequest & { customer: { name: string } | null };

function Section({ title, testid, rows }: { title: string; testid: string; rows: Row[] }) {
  return (
    <section aria-label={title} data-testid={testid} className="mb-6">
      <h2 className="mb-2 flex items-center gap-2 text-[18px] font-bold">
        <span>{title}</span>
        <span data-testid={`${testid}-count`} className="rounded-full bg-white px-2.5 py-0.5 text-[14px] text-muted">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-line px-3 py-3 text-[13px] text-muted">No requests</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <li key={r.id} className="min-w-0">
              <Link href={`/admin/rates/${r.id}`} data-testid="admin-rate-row" data-ref={r.ref} className="block rounded-[16px] border border-line bg-card p-3 hover:border-ink">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[16px] font-bold">{r.ref}</span>
                  <RateStatusBadge status={r.status} audience="staff" />
                </div>
                <p className="mt-1 break-words text-[15px]">{rateLane(r)}</p>
                <p className="mt-1 break-words text-[13px] text-muted">{r.customer?.name ?? "Unknown customer"}, requested {fmtDateTime(r.created_at)}</p>
                {r.status === "quoted" && r.quoted_amount !== null && r.quoted_currency ? (
                  <p className="mt-1 text-[14px] font-medium">Rate {fmtMoney(r.quoted_amount, r.quoted_currency)}</p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// STAFF ONLY (requireStaff, and RLS on rate_requests refuses everyone else again). Open first, then quoted, newest first.
export default async function AdminRatesPage() {
  const profile = await requireStaff();
  const sb = await createClient();
  const { data, error } = await sb.from("rate_requests").select("*,customer:customers(name)").order("created_at", { ascending: false }).limit(500);
  const rows = (data ?? []) as unknown as Row[];
  const by = (s: Row["status"]) => rows.filter((r) => r.status === s);
  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <PageTitle>Rate requests</PageTitle>
      <p className="mb-4 max-w-2xl text-[15px] text-muted">
        A customer asked for a rate on a lane that is not in the system. Open a request, enter the rate, and the customer is emailed that it is in the app. A rate request is not a load.
      </p>
      {error ? <div className="mb-4"><Notice tone="error">Could not load rate requests: {error.message}</Notice></div> : null}
      <Section title="Open" testid="rates-open" rows={by("open")} />
      <Section title="Quoted" testid="rates-quoted" rows={by("quoted")} />
      <Section title="Cancelled" testid="rates-cancelled" rows={by("cancelled")} />
    </Shell>
  );
}
