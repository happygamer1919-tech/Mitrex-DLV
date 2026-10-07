import { LiveRefresh } from "@/components/LiveRefresh";
import { Shell } from "@/components/Shell";
import { Card, LinkButton, Notice, PageTitle } from "@/components/ui";
import { ActionForm } from "@/components/admin/ActionForm";
import { RateRequestForm } from "@/components/rates/RateRequestForm";
import { RateStatusBadge } from "@/components/rates/RateStatusBadge";
import { requireCustomer } from "@/lib/auth";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { cancelRateRequest } from "@/lib/rates/actions";
import { fmtMoney, rateLane, type RateRequest } from "@/lib/rates/validate";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Customers only. A rate request is not a load: it books nothing and creates no load.
export default async function RatesPage({ searchParams }: { searchParams: Promise<{ requested?: string }> }) {
  const { requested } = await searchParams;
  const profile = await requireCustomer();
  const sb = await createClient();
  const { data, error } = await sb.from("rate_requests").select("*").order("created_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as RateRequest[];
  // The banner parameter is untrusted: only a ref of the shape RQ-0001 that is one of the customer's own rows shows.
  const banner = typeof requested === "string" && /^RQ-\d{4,}$/.test(requested) && rows.some((r) => r.ref === requested) ? requested : null;

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <PageTitle>Rates</PageTitle>
      <p className="mb-4 max-w-2xl text-[15px] text-muted">
        Need a price for a lane that is not in the system? Ask here. DLV enters the rate and emails you that it is in the app. This does not book a load.
      </p>
      {banner ? (
        <div className="mb-4">
          <Notice tone="ok"><span data-testid="rate-requested-banner">Rate request {banner} sent. We will email you when the rate is in the app.</span></Notice>
        </div>
      ) : null}
      <section aria-label="Request a rate" className="mb-8 max-w-2xl">
        <h2 className="mb-3 text-[20px] font-bold">Request a rate</h2>
        <RateRequestForm />
      </section>
      <section aria-label="Your rate requests">
        <h2 className="mb-3 text-[20px] font-bold">Your rate requests</h2>
        {error ? <Notice tone="error">Could not load your rate requests: {error.message}</Notice> : null}
        {!error && rows.length === 0 ? <Card><p data-testid="rates-empty" className="text-[16px]">You have no rate requests yet.</p></Card> : null}
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} data-testid="rate-row" data-ref={r.ref} className="rounded-[16px] border border-line bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[18px] font-bold">{r.ref}</span>
                <RateStatusBadge status={r.status} />
              </div>
              <p className="mt-1 break-words text-[16px]" data-testid="rate-lane">{rateLane(r)}</p>
              <p className="text-[13px] text-muted">Requested {fmtDateTime(r.created_at)}</p>
              {r.status === "quoted" && r.quoted_amount !== null && r.quoted_currency ? (
                <div className="mt-3 rounded-[12px] bg-mint p-3" data-testid="rate-quote">
                  <p className="text-[13px] text-muted">Your rate</p>
                  <p data-testid="rate-amount" className="text-[28px] font-bold leading-tight">{fmtMoney(r.quoted_amount, r.quoted_currency)}</p>
                  {r.quote_notes ? <p data-testid="rate-quote-notes" className="mt-1 whitespace-pre-wrap break-words text-[15px]">{r.quote_notes}</p> : null}
                  {r.quote_valid_until ? <p data-testid="rate-valid-until" className="mt-1 text-[14px]">Valid until {fmtDate(r.quote_valid_until)}</p> : null}
                  <div className="mt-3"><LinkButton href="/book" variant="dark">Book this lane</LinkButton></div>
                </div>
              ) : null}
              {r.status === "open" ? (
                <div className="mt-3">
                  <ActionForm
                    action={cancelRateRequest}
                    fields={{ id: r.id }}
                    label="Cancel request"
                    variant="ghost"
                    confirm={`Cancel rate request ${r.ref}?`}
                    confirmLabel="Yes, cancel it"
                    pendingLabel="Cancelling..."
                    showOk={false}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </Shell>
  );
}
