import { Shell } from "@/components/Shell";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Card, Notice, PageTitle } from "@/components/ui";
import { LoadCard } from "@/components/carrier/LoadCard";
import { requireCarrier } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_STATUSES, LOAD_SELECT, type CarrierLoad } from "@/lib/carrier/loads";

export const dynamic = "force-dynamic";

export default async function MyLoadsPage() {
  const profile = await requireCarrier();
  const supabase = await createClient();
  // Active loads are never cut off by old finished ones: two queries, oldest pickup first for the
  // active list, most recent first for the finished list.
  const [activeRes, doneRes] = await Promise.all([
    supabase.from("loads").select(LOAD_SELECT).in("status", ACTIVE_STATUSES)
      .order("pickup_date", { ascending: true }).order("pickup_time_start", { ascending: true }).limit(300),
    supabase.from("loads").select(LOAD_SELECT).not("status", "in", `(${ACTIVE_STATUSES.join(",")})`)
      .order("pickup_date", { ascending: false }).order("pickup_time_start", { ascending: false }).limit(100),
  ]);
  const error = activeRes.error ?? doneRes.error;
  const active = (activeRes.data ?? []) as unknown as CarrierLoad[];
  const done = (doneRes.data ?? []) as unknown as CarrierLoad[];

  return (
    <Shell profile={profile} driver>
      <LiveRefresh />
      <PageTitle>My loads</PageTitle>
      {error ? <Notice tone="error">Could not load your loads. Pull down to refresh or try again in a moment.</Notice> : null}

      <section aria-labelledby="active-h" className="mb-8">
        <h2 id="active-h" className="mb-3 text-[20px] font-bold">Active</h2>
        {active.length === 0 ? (
          <Card className="text-ink">
            <p className="text-[16px] font-bold">No active loads</p>
            <p className="text-[15px] text-muted">When dispatch books a load for your carrier it shows up here.</p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {active.map((l) => (
              <li key={l.id}><LoadCard load={l} /></li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="done-h">
        <h2 id="done-h" className="mb-3 text-[20px] font-bold">Delivered and cancelled</h2>
        {done.length === 0 ? (
          <Card className="text-ink">
            <p className="text-[15px] text-muted">Finished loads appear here.</p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {done.map((l) => (
              <li key={l.id}><LoadCard load={l} /></li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
