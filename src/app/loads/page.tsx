import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { LoadNumber } from "@/components/LoadNumber";
import { customerLabel } from "@/lib/load-number";
import { Shell } from "@/components/Shell";
import { Disclosure } from "@/components/Disclosure";
import { LoadFilterControls } from "@/components/admin/BoardFilters";
import { Card, LinkButton, Notice, StatusChip, btnClass } from "@/components/ui";
import { canReturn } from "@/lib/customer/returnLoad";
import { requireCustomer } from "@/lib/auth";
import { LOAD_SELECT, type LoadWithRefs } from "@/lib/customer/queries";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import {
  applyFilters, easternToday, isDefaultSort, isFiltered, parseFilters, parsePages, pushDown, resolveSearchIds,
  sortLoads, toQuery, withParams,
} from "@/lib/load-filters";

export const dynamic = "force-dynamic";

const STATUSES = Object.keys(STATUS_LABEL) as LoadStatus[];
const ACTIVE: LoadStatus[] = ["requested", "booked", "at_pickup", "loading", "enroute", "at_delivery"];
// R46 compact views for Maria: page size of "Show older" and the default window of the Delivered group.
const OLDER_PAGE = 25;
const WINDOW_DAYS = 30;
const CAP = 500; // most rows one group query returns

type Res = { data: unknown; error: { message: string } | null; count?: number | null };
const rowsOf = (r: Res) => (r.data ?? []) as unknown as LoadWithRefs[];

function distinct(pairs: { id: string; name: string | undefined }[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  pairs.forEach((p) => { if (p.name) m.set(p.id, p.name); });
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// One compact row: number, route, pickup, carrier and status on the link line; Request again and Return stay
// reachable without expanding anything.
function Row({ l }: { l: LoadWithRefs }) {
  const pickupTime = l.pickup_timing === "window" && l.pickup_time_end
    ? `${fmtTime(l.pickup_time_start)} to ${fmtTime(l.pickup_time_end)} ET`
    : `${fmtTime(l.pickup_time_start)} ET`;
  return (
    <li data-testid="customer-load-row" data-load-id={l.id} className="rounded-[16px] border border-line bg-card hover:border-ink">
      <Link href={`/loads/${l.id}`} className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 rounded-[16px] px-4 py-2">
        <span className="text-[17px] font-bold"><LoadNumber l={l} audience="customer" /></span>
        <span className="min-w-0 max-w-full text-[15px] [overflow-wrap:anywhere]">{l.pickup?.name ?? "Unknown location"} to {l.delivery?.name ?? "Unknown location"}</span>
        <span className="text-[14px] text-muted">Pickup {fmtDate(l.pickup_date)}, {pickupTime}</span>
        {l.carrier ? <span className="text-[14px] text-muted">Carrier: {l.carrier.name}</span> : null}
        {l.status === "delivered" && l.delivered_at ? (
          <span data-testid="delivered-date" className="text-[14px] font-medium">Delivered {fmtDateTime(l.delivered_at)}</span>
        ) : null}
        {l.eta ? <span className="text-[14px] font-medium">ETA {fmtDateTime(l.eta)}</span> : null}
        <StatusChip status={l.status} />
      </Link>
      {l.status === "delivered" || canReturn(l.status) ? (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {l.status === "delivered" ? <LinkButton href={`/book?from=${l.id}`} variant="dark">Request again</LinkButton> : null}
          {canReturn(l.status) ? (
            <Link href={`/book?return=${l.id}`} data-testid="return-button" className={btnClass("ghost")}>Return</Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default async function LoadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const profile = await requireCustomer();
  // R46: the list state lives in the URL and is validated strictly (bad values are ignored). "Completed" (view=completed)
  // shows the delivered loads only, newest delivery first.
  const f = parseFilters(sp, "customer");
  const filtered = isFiltered(f);
  const completed = f.view === "completed";
  const older = { delivered: parsePages(sp.dold), cancelled: parsePages(sp.cold) };
  const booked = Array.isArray(sp.booked) ? sp.booked[0] : sp.booked;
  const today = easternToday();
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const supabase = await createClient();
  const ids = filtered && f.q ? await resolveSearchIds(supabase, f) : new Map();

  const wantActive = !completed && (!f.status || ACTIVE.includes(f.status));
  const wantDelivered = completed ? !f.status || f.status === "delivered" : !f.status || f.status === "delivered";
  const wantCancelled = !completed && (!f.status || f.status === "cancelled");
  const none = Promise.resolve({ data: [], error: null } as Res);
  const base = () => supabase.from("loads").select(LOAD_SELECT);
  // Never every delivered load (R46): without a filter the Delivered group holds the deliveries of the last 30 days plus
  // the older pages asked for, and Cancelled the newest pages; with a filter, only matching rows (pushed into the query).
  const narrow = <T,>(q: T) => (filtered ? pushDown(q, f, today, ids) : q);
  const deliveredBase = () => base().eq("status", "delivered")
    .order("delivered_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
  // The deliveries of the last 30 days are counted first; the Delivered group then is ONE limited query (that window plus
  // OLDER_PAGE more per "Show older"), so the older pages continue exactly where the window ends.
  const winCount = wantDelivered && !filtered
    ? (await supabase.from("loads").select("id", { count: "exact", head: true }).eq("status", "delivered").gte("delivered_at", cutoff)).count ?? 0
    : 0;
  const deliveredLimit = Math.min(winCount, CAP) + OLDER_PAGE * older.delivered;
  const [activeR, delR, canR, delCount, canCount] = await Promise.all([
    wantActive ? narrow(base().in("status", ACTIVE)).order("created_at", { ascending: false }).limit(CAP) : none,
    !wantDelivered ? none
      : filtered ? narrow(deliveredBase()).limit(CAP)
        : deliveredLimit > 0 ? deliveredBase().limit(deliveredLimit) : none,
    !wantCancelled ? none
      : narrow(base().eq("status", "cancelled")).order("created_at", { ascending: false }).limit(filtered ? CAP : OLDER_PAGE * (older.cancelled + 1)),
    supabase.from("loads").select("id", { count: "exact", head: true }).eq("status", "delivered"),
    supabase.from("loads").select("id", { count: "exact", head: true }).eq("status", "cancelled"),
  ]) as Res[];
  const error = activeR.error ?? delR.error ?? canR.error;
  const loaded = { active: rowsOf(activeR), delivered: rowsOf(delR), cancelled: rowsOf(canR) };
  const all = [...loaded.active, ...loaded.delivered, ...loaded.cancelled];
  const totals = { active: loaded.active.length, delivered: delCount.count ?? 0, cancelled: canCount.count ?? 0 };
  const groups = {
    active: applyFilters(loaded.active, f, today),
    // Finished groups list the most recent first while the sort is the default.
    delivered: isDefaultSort(f) ? sortLoads(applyFilters(loaded.delivered, f, today), { sort: "delivered", dir: "desc" }) : applyFilters(loaded.delivered, f, today),
    cancelled: isDefaultSort(f) ? sortLoads(applyFilters(loaded.cancelled, f, today), { sort: "created", dir: "desc" }) : applyFilters(loaded.cancelled, f, today),
  };
  const shipperOpts = distinct(all.map((l) => ({ id: l.pickup_location_id, name: l.pickup?.name })));
  const receiverOpts = distinct(all.map((l) => ({ id: l.delivery_location_id, name: l.delivery?.name })));
  const countText = (g: keyof typeof groups) => (filtered ? `${groups[g].length} of ${totals[g]}` : String(totals[g]));
  const href = (patch: Record<string, number>) =>
    `/loads${withParams(toQuery(f), { dold: older.delivered, cold: older.cancelled, ...patch })}`;

  // Success banner after a multi-truck booking. The parameter is untrusted: strict shape, at most 10 ids, and only
  // loads the customer can read (RLS) are shown. Anything malformed is ignored.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const wanted = typeof booked === "string" ? [...new Set(booked.split(","))] : []; // duplicates collapse
  const bookedIds = wanted.length >= 2 && wanted.length <= 10 && wanted.every((x) => UUID.test(x)) ? wanted : [];
  let bookedLoads: { id: string; load_number: string; its_load_number: string | null }[] = [];
  if (bookedIds.length > 0) {
    const { data: found } = await supabase.from("loads").select("id,load_number,its_load_number").in("id", bookedIds);
    const byId = new Map(((found ?? []) as { id: string; load_number: string; its_load_number: string | null }[]).map((r) => [r.id, r]));
    bookedLoads = bookedIds.map((id) => byId.get(id)).filter((r): r is { id: string; load_number: string; its_load_number: string | null } => Boolean(r));
  }

  const chip = (active: boolean) =>
    `inline-flex min-h-[44px] items-center rounded-full border px-4 text-[15px] font-medium whitespace-nowrap ${
      active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink"}`;
  const nothing = all.length === 0 && !filtered;
  const shownCount = groups.active.length + groups.delivered.length + groups.cancelled.length;

  const group = (key: keyof typeof groups, title: string, open: boolean, extra?: React.ReactNode, footer?: React.ReactNode) => (
    <section aria-label={title} data-testid={`group-${key}`} className="mb-4">
      <Disclosure
        open={open}
        testid={`group-toggle-${key}`}
        summary={
          <h2 className="flex items-center gap-2 text-[20px] font-bold">
            <span>{title}</span>
            <span data-testid={`group-count-${key}`} className="rounded-full bg-white px-2.5 py-0.5 text-[14px] font-medium text-muted">{countText(key)}</span>
          </h2>
        }
      >
        <div className="mt-2">
          {extra}
          {groups[key].length === 0 ? (
            <p className="rounded-[16px] border border-dashed border-line px-3 py-3 text-[14px] text-muted">
              {filtered ? "No loads match these filters." : "No loads here."}
            </p>
          ) : (
            <ul className="space-y-2">{groups[key].map((l) => <Row key={l.id} l={l} />)}</ul>
          )}
          {footer}
        </div>
      </Disclosure>
    </section>
  );
  const olderLink = (key: "delivered" | "cancelled") =>
    !filtered && loaded[key].length < totals[key] && older[key] < 20 ? (
      <Link href={href(key === "delivered" ? { dold: older.delivered + 1 } : { cold: older.cancelled + 1 })}
        data-testid={`group-older-${key}`}
        className="mt-2 inline-flex min-h-[44px] items-center rounded-full border border-ink bg-white px-4 text-[14px] font-medium">
        Show older ({OLDER_PAGE} more)
      </Link>
    ) : null;

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[24px] font-bold">My loads</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/loads/export" data-testid="export-link" className={btnClass("ghost")}>Export CSV</Link>
          <LinkButton href="/book">Book a load</LinkButton>
        </div>
      </div>
      {bookedLoads.length > 0 ? (
        <div className="mb-4">
          <Notice tone="ok">
            <span data-testid="booked-banner">
              {bookedLoads.length} {bookedLoads.length === 1 ? "load" : "loads"} requested: {bookedLoads.map((l) => customerLabel(l)).join(", ")}. Each truck is its own load.
            </span>
          </Notice>
        </div>
      ) : null}
      <nav aria-label="Filter by status" className="mb-3 flex gap-2 overflow-x-auto pb-1">
        <Link href="/loads" className={chip(!f.status && !completed)}>All</Link>
        <Link href="/loads?view=completed" className={chip(completed)}>Completed</Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/loads?status=${s}`} className={chip(f.status === s && !completed)}>{STATUS_LABEL[s]}</Link>
        ))}
      </nav>
      <LoadFilterControls scope="customer" base="/loads" f={f} shippers={shipperOpts} receivers={receiverOpts} />
      {error ? <Notice tone="error">Could not load your loads: {error.message}</Notice> : null}
      {!error && nothing ? (
        <Card className="mb-4 text-center">
          <p className="mb-3 text-[16px]">
            {completed ? "No completed loads yet." : "You have no loads yet."}
          </p>
          <LinkButton href="/book">Book your first load</LinkButton>
        </Card>
      ) : null}
      {filtered ? <p data-testid="loads-match-count" className="mb-3 text-[14px] text-muted">{shownCount} {shownCount === 1 ? "load matches" : "loads match"}</p> : null}
      {!nothing ? (
        <>
          {wantActive ? group("active", "Active", filtered ? groups.active.length > 0 : true) : null}
          {wantDelivered ? group(
            "delivered", "Delivered",
            completed || f.status === "delivered" || (filtered ? groups.delivered.length > 0 : older.delivered > 0),
            !filtered ? (
              <p data-testid="group-window-delivered" className="mb-2 text-[13px] text-muted">
                Delivered in the last {WINDOW_DAYS} days{older.delivered > 0 ? " and older" : ""}, newest first: {loaded.delivered.length} of {totals.delivered}.
              </p>
            ) : null,
            olderLink("delivered"),
          ) : null}
          {wantCancelled ? group("cancelled", "Cancelled", f.status === "cancelled" || (filtered ? groups.cancelled.length > 0 : older.cancelled > 0), null, olderLink("cancelled")) : null}
        </>
      ) : null}
    </Shell>
  );
}
