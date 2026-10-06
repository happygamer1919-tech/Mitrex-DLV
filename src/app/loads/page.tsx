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

export default async function LoadsPage({ searchParams }: { searchParams: Promise<{ status?: string; booked?: string; view?: string }> }) {
  const { status, booked, view } = await searchParams;
  const profile = await requireCustomer();
  const completed = view === "completed"; // quick filter: delivered loads, newest delivery first
  const filter = completed ? null : STATUSES.find((s) => s === status) ?? null;
  const supabase = await createClient();
  let q = supabase.from("loads").select(LOAD_SELECT);
  q = completed
    ? q.eq("status", "delivered").order("delivered_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false })
    : q.order("created_at", { ascending: false });
  q = q.limit(300);
  if (filter) q = q.eq("status", filter);
  const { data, error } = await q;
  const loads = (data ?? []) as unknown as LoadWithRefs[];

  // Success banner after a multi-truck booking. The parameter is untrusted: strict shape, at most 10 ids, and only
  // loads the customer can read (RLS) are shown. Anything malformed is ignored.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const wanted = typeof booked === "string" ? [...new Set(booked.split(","))] : []; // duplicates collapse
  const bookedIds = wanted.length >= 2 && wanted.length <= 10 && wanted.every((x) => UUID.test(x)) ? wanted : [];
  let bookedLoads: { id: string; load_number: string }[] = [];
  if (bookedIds.length > 0) {
    const { data: found } = await supabase.from("loads").select("id,load_number").in("id", bookedIds);
    const byId = new Map(((found ?? []) as { id: string; load_number: string }[]).map((r) => [r.id, r]));
    bookedLoads = bookedIds.map((id) => byId.get(id)).filter((r): r is { id: string; load_number: string } => Boolean(r));
  }

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
      {bookedLoads.length > 0 ? (
        <div className="mb-4">
          <Notice tone="ok">
            <span data-testid="booked-banner">
              {bookedLoads.length} {bookedLoads.length === 1 ? "load" : "loads"} requested: {bookedLoads.map((l) => l.load_number).join(", ")}. Each truck is its own load.
            </span>
          </Notice>
        </div>
      ) : null}
      <nav aria-label="Filter by status" className="mb-4 flex gap-2 overflow-x-auto pb-1">
        <Link href="/loads" className={chip(!filter && !completed)}>All</Link>
        <Link href="/loads?view=completed" className={chip(completed)}>Completed</Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/loads?status=${s}`} className={chip(filter === s)}>{STATUS_LABEL[s]}</Link>
        ))}
      </nav>
      {error ? <Notice tone="error">Could not load your loads: {error.message}</Notice> : null}
      {!error && loads.length === 0 ? (
        <Card className="text-center">
          <p className="mb-3 text-[16px]">
            {completed ? "No completed loads yet." : filter ? `No ${STATUS_LABEL[filter].toLowerCase()} loads.` : "You have no loads yet."}
          </p>
          <LinkButton href="/book">Book your first load</LinkButton>
        </Card>
      ) : null}
      <ul className="space-y-3">
        {loads.map((l) => (
          <li key={l.id} className="rounded-[16px] border border-line bg-card hover:border-ink">
            <Link href={`/loads/${l.id}`} className="block rounded-[16px] p-4">
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
              {l.status === "delivered" && l.delivered_at ? (
                <p data-testid="delivered-date" className="text-[15px] font-medium">Delivered {fmtDateTime(l.delivered_at)}</p>
              ) : null}
              {l.eta ? <p className="text-[15px] font-medium">ETA {fmtDateTime(l.eta)}</p> : null}
              {l.carrier ? <p className="text-[15px] text-muted">Carrier: {l.carrier.name}</p> : null}
            </Link>
            {l.status === "delivered" ? (
              <div className="px-4 pb-4">
                <LinkButton href={`/book?from=${l.id}`} variant="dark">Request again</LinkButton>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Shell>
  );
}
