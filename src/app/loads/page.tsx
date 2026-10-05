import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Shell } from "@/components/Shell";
import { Card, LinkButton, Notice, StatusChip } from "@/components/ui";
import { requireCustomer } from "@/lib/auth";
import { LOAD_SELECT, type LoadWithRefs } from "@/lib/customer/queries";
import { fmtDateTime, fmtSlot } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES = Object.keys(STATUS_LABEL) as LoadStatus[];

export default async function LoadsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const profile = await requireCustomer();
  const filter = STATUSES.find((s) => s === status) ?? null;
  const supabase = await createClient();
  let q = supabase.from("loads").select(LOAD_SELECT).order("created_at", { ascending: false }).limit(300);
  if (filter) q = q.eq("status", filter);
  const { data, error } = await q;
  const loads = (data ?? []) as unknown as LoadWithRefs[];

  const chip = (active: boolean) =>
    `inline-flex min-h-[44px] items-center rounded-full border px-4 text-[15px] font-medium whitespace-nowrap ${
      active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink"}`;

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[24px] font-bold">My loads</h1>
        <LinkButton href="/book">Book a load</LinkButton>
      </div>
      <nav aria-label="Filter by status" className="mb-4 flex gap-2 overflow-x-auto pb-1">
        <Link href="/loads" className={chip(!filter)}>All</Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/loads?status=${s}`} className={chip(filter === s)}>{STATUS_LABEL[s]}</Link>
        ))}
      </nav>
      {error ? <Notice tone="error">Could not load your loads: {error.message}</Notice> : null}
      {!error && loads.length === 0 ? (
        <Card className="text-center">
          <p className="mb-3 text-[16px]">
            {filter ? `No ${STATUS_LABEL[filter].toLowerCase()} loads.` : "You have no loads yet."}
          </p>
          <LinkButton href="/book">Book your first load</LinkButton>
        </Card>
      ) : null}
      <ul className="space-y-3">
        {loads.map((l) => (
          <li key={l.id}>
            <Link href={`/loads/${l.id}`} className="block rounded-[16px] border border-line bg-card p-4 hover:border-ink">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[18px] font-bold">{l.load_number}</span>
                <StatusChip status={l.status} />
              </div>
              <p className="mt-1 text-[16px] break-words">
                {l.pickup?.name ?? "Unknown location"} to {l.delivery?.name ?? "Unknown location"}
              </p>
              <p className="text-[15px] text-muted">
                Pickup: {fmtSlot(l.pickup_timing, l.pickup_date, l.pickup_time_start, l.pickup_time_end)}
              </p>
              {l.eta ? <p className="text-[15px] font-medium">ETA {fmtDateTime(l.eta)}</p> : null}
              {l.carrier ? <p className="text-[15px] text-muted">Carrier: {l.carrier.name}</p> : null}
            </Link>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
