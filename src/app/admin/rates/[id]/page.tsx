import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Card, Notice, PageTitle } from "@/components/ui";
import { RateQuoteForm } from "@/components/rates/RateQuoteForm";
import { RateStatusBadge } from "@/components/rates/RateStatusBadge";
import { requireStaff } from "@/lib/auth";
import { UUID } from "@/lib/admin/errors";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fmtMoney, rateLane, type RateRequest } from "@/lib/rates/validate";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function Row({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="py-1.5 sm:grid sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-[13px] font-medium text-muted">{label}</dt>
      <dd data-testid={testid} className="whitespace-pre-wrap break-words text-[15px]">{value}</dd>
    </div>
  );
}

// STAFF ONLY. Details of one rate request and the form that enters (or corrects) the rate.
export default async function AdminRateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireStaff();
  if (!UUID.test(id)) notFound();
  const sb = await createClient();
  const { data, error } = await sb.from("rate_requests").select("*,customer:customers(name)").eq("id", id).maybeSingle();
  if (error) {
    return <Shell profile={profile}><Notice tone="error">Could not load this request: {error.message}</Notice></Shell>;
  }
  if (!data) notFound();
  const r = data as unknown as RateRequest & { customer: { name: string } | null };
  const ids = [r.requested_by, r.quoted_by].filter((v): v is string => !!v);
  const names = new Map<string, string>();
  const { data: ps } = await sb.from("profiles").select("id,email,full_name").in("id", ids);
  ((ps ?? []) as { id: string; email: string; full_name: string | null }[]).forEach((p) => names.set(p.id, p.full_name ? `${p.full_name} (${p.email})` : p.email));

  return (
    <Shell profile={profile}>
      <p className="mb-2"><Link href="/admin/rates" className="inline-flex min-h-[44px] items-center text-[15px] underline">Back to rate requests</Link></p>
      <PageTitle>Rate request <span data-testid="rate-ref">{r.ref}</span></PageTitle>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[20px] font-bold">Request</h2>
            <RateStatusBadge status={r.status} audience="staff" />
          </div>
          <dl className="divide-y divide-line">
            <Row label="Lane" value={rateLane(r)} testid="rate-lane" />
            <Row label="Customer" value={r.customer?.name ?? "Unknown customer"} />
            <Row label="Requested by" value={names.get(r.requested_by) ?? "Unknown user"} />
            <Row label="Requested" value={fmtDateTime(r.created_at)} />
            <Row label="Equipment" value={`${r.equipment_size} ft`} />
            <Row label="Weight" value={r.weight_lbs ? `${r.weight_lbs} lbs` : "Not given"} />
            <Row label="Dimensions" value={r.dims ?? "Not given"} />
            <Row label="Notes" value={r.notes ?? "None"} />
          </dl>
        </Card>
        <Card className="min-w-0">
          <h2 className="mb-2 text-[20px] font-bold">Rate</h2>
          {r.status === "cancelled" ? (
            <Notice tone="warn">The customer cancelled this request. A rate can no longer be entered.</Notice>
          ) : (
            <>
              {r.status === "quoted" && r.quoted_amount !== null && r.quoted_currency ? (
                <div className="mb-4 rounded-[12px] bg-mint p-3" data-testid="existing-quote">
                  <p className="text-[13px] text-muted">Current rate</p>
                  <p data-testid="existing-amount" className="text-[28px] font-bold leading-tight">{fmtMoney(r.quoted_amount, r.quoted_currency)}</p>
                  {r.quote_notes ? <p className="mt-1 whitespace-pre-wrap break-words text-[15px]">{r.quote_notes}</p> : null}
                  {r.quote_valid_until ? <p className="mt-1 text-[14px]">Valid until {fmtDate(r.quote_valid_until)}</p> : null}
                  <p className="mt-1 text-[13px] text-muted">Entered by {r.quoted_by ? names.get(r.quoted_by) ?? "Unknown user" : "Unknown"}{r.quoted_at ? `, ${fmtDateTime(r.quoted_at)}` : ""}</p>
                </div>
              ) : null}
              <h3 className="mb-2 text-[16px] font-bold">{r.status === "quoted" ? "Correct the rate" : "Enter the rate"}</h3>
              <RateQuoteForm
                id={r.id}
                existing={r.status === "quoted" && r.quoted_amount !== null && r.quoted_currency
                  ? { amount: Number(r.quoted_amount).toFixed(2), currency: r.quoted_currency, notes: r.quote_notes ?? "", validUntil: r.quote_valid_until ?? "" }
                  : null}
              />
              <p className="mt-3 text-[13px] text-muted">Saving emails the customer that the rate is in the app. The email never carries the amount.</p>
            </>
          )}
        </Card>
      </div>
    </Shell>
  );
}
