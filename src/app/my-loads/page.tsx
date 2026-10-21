import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Disclosure } from "@/components/Disclosure";
import { addDays } from "@/lib/admin/cal";
import { easternToday, parsePages } from "@/lib/load-filters";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Card, Notice, PageTitle } from "@/components/ui";
import { LoadCard } from "@/components/carrier/LoadCard";
import { requireCarrier } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_STATUSES, LOAD_SELECT, type CarrierLoad } from "@/lib/carrier/loads";

export const dynamic = "force-dynamic";

const OLDER_PAGE = 25; // R46: finished loads each "Show older" adds
const WINDOW_DAYS = 30; // R46: finished loads with a pickup in the last 30 days show by default

export default async function MyLoadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const profile = await requireCarrier();
  const sp = await searchParams;
  const older = parsePages(sp.older); // strict: digits 1 to 20, anything else is 0
  const cutoff = addDays(easternToday(), -WINDOW_DAYS);
  const supabase = await createClient();
  // Active loads are never cut off by old finished ones: two queries, oldest pickup first for the
  // active list, most recent first for the finished list. load_number breaks ties (many loads share a
  // pickup date and time), so the capped list is the same on every request and for every user of the carrier.
  // R46: the finished list is never fetched whole. The pickups of the last 30 days are counted first; the list is then
  // ONE limited query (that window, at most 300, plus OLDER_PAGE more per "Show older"), so older pages continue exactly
  // where the window ends. The total is a count.
  const notActive = `(${ACTIVE_STATUSES.join(",")})`;
  const [windowRes, doneCount] = await Promise.all([
    supabase.from("loads").select("id", { count: "exact", head: true }).not("status", "in", notActive).gte("pickup_date", cutoff),
    supabase.from("loads").select("id", { count: "exact", head: true }).not("status", "in", notActive),
  ]);
  const doneLimit = Math.min(windowRes.count ?? 0, 300) + OLDER_PAGE * older;
  const [activeRes, doneRes] = await Promise.all([
    supabase.from("loads").select(LOAD_SELECT).in("status", ACTIVE_STATUSES)
      .order("pickup_date", { ascending: true }).order("pickup_time_start", { ascending: true }).order("load_number", { ascending: true }).limit(300),
    doneLimit > 0
      ? supabase.from("loads").select(LOAD_SELECT).not("status", "in", notActive)
        .order("pickup_date", { ascending: false }).order("pickup_time_start", { ascending: false }).order("load_number", { ascending: false }).limit(doneLimit)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const error = activeRes.error ?? doneRes.error;
  const active = (activeRes.data ?? []) as unknown as CarrierLoad[];
  const done = (doneRes.data ?? []) as unknown as CarrierLoad[];
  const doneTotal = doneCount.count ?? done.length;

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

      {/* R46: finished loads are collapsed (one tap opens them); pickups of the last 30 days, then Show older. */}
      <section aria-label="Delivered and cancelled" data-testid="carrier-done">
        <Disclosure
          driver
          open={older > 0}
          testid="carrier-done-toggle"
          summary={
            <h2 id="done-h" className="flex items-center gap-2 text-[20px] font-bold">
              <span>Delivered and cancelled</span>
              <span data-testid="carrier-done-count" className="rounded-full bg-white px-2.5 py-0.5 text-[14px] font-medium text-ink">{doneTotal}</span>
            </h2>
          }
        >
          <div className="mt-3">
            <p data-testid="carrier-done-window" className="mb-3 text-[15px] text-white/80">
              Pickups from the last {WINDOW_DAYS} days{older > 0 ? " and older" : ""}, newest first: {done.length} of {doneTotal}.
            </p>
            {done.length === 0 ? (
              <Card className="text-ink">
                <p className="text-[15px] text-muted">{doneTotal > 0 ? `No pickups in the last ${WINDOW_DAYS} days.` : "Finished loads appear here."}</p>
              </Card>
            ) : (
              <ul className="space-y-3">
                {done.map((l) => (
                  <li key={l.id}><LoadCard load={l} /></li>
                ))}
              </ul>
            )}
            {done.length < doneTotal && older < 20 ? (
              <Link href={`/my-loads?older=${older + 1}`} data-testid="carrier-done-older"
                className="mt-3 inline-flex min-h-[48px] items-center rounded-full border border-white bg-transparent px-5 text-[16px] font-bold text-white">
                Show older ({OLDER_PAGE} more)
              </Link>
            ) : null}
          </div>
        </Disclosure>
      </section>
    </Shell>
  );
}
