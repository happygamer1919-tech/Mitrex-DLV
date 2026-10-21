import Link from "next/link";
import { Shell } from "@/components/Shell";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Notice, PageTitle } from "@/components/ui";
import { LoadNumber } from "@/components/LoadNumber";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDate, fmtDateTime, telHref } from "@/lib/format";
import { Disclosure } from "@/components/Disclosure";
import { addDays } from "@/lib/admin/cal";
import { isDefaultSort, parsePages, pushDown, resolveSearchIds, withParams } from "@/lib/load-filters";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import { deletedBanner } from "@/lib/admin/delete-load";
import { resolveMany, scenarioKey, type LaneReference } from "@/lib/admin/lane-reference";
import { BoardFilters, SORT_LABEL } from "@/components/admin/BoardFilters";
import { applyFilters, easternToday, isFiltered, parseFilters, sortLoads, toQuery, type BoardFilters as F, type SortKey } from "@/lib/admin/board-filters";
import { BOARD_SELECT, bolPending, isReturn, pickupTimeLabel, podPending, routeOf, type BoardLoad } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

const COLUMNS: LoadStatus[] = [
  "requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered", "cancelled",
];
// R46 compact views: page sizes and the default window of the finished bands.
const BAND_PAGE = 12; // cards an open band shows before "Show all"
const OLDER_PAGE = 50; // finished loads each "Show older" adds
const LIST_PAGE = 50; // rows of the One list view before "Show more"
const WINDOW_DAYS = 30; // finished bands: pickups of the last 30 days by default
const FILTER_CAP = 500; // most rows a finished band query returns
const FINISHED = ["delivered", "cancelled"] as const;
type Finished = (typeof FINISHED)[number];
const isFinished = (s: LoadStatus): s is Finished => s === "delivered" || s === "cancelled";

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function distinct(pairs: { id: string; name: string | undefined }[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  pairs.forEach((p) => { if (p.name) m.set(p.id, p.name); });
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

function SortHeader({ f, k }: { f: F; k: SortKey }) {
  const active = f.sort === k;
  const next = active && f.dir === "asc" ? "desc" : "asc";
  return (
    <th scope="col" aria-sort={active ? (f.dir === "asc" ? "ascending" : "descending") : "none"} className="px-3 py-2 text-left text-[13px] font-medium text-muted">
      <Link href={`/admin${toQuery({ ...f, sort: k, dir: next })}`} className="inline-flex min-h-[44px] items-center gap-1">
        {SORT_LABEL[k]}{active ? <span aria-hidden="true">{f.dir === "asc" ? " ^" : " v"}</span> : null}
      </Link>
    </th>
  );
}

// R46: a compact card. The link line holds the number, the route, the pickup date and time, the carrier and the badges;
// "Details" (a native disclosure) reveals the contacts, equipment and Moffett, PO, notes and ETA.
function LoadCard({ l, copy }: { l: BoardLoad; copy: LaneReference | null | undefined }) {
  const tel = (p?: string) => (p ? <a href={telHref(p)} className="underline">{p}</a> : null);
  return (
    <div data-testid="board-card" data-load-id={l.id} className="flex flex-wrap items-start gap-x-2 rounded-[16px] border border-line bg-card px-3 py-1 hover:border-ink">
      <Link href={`/admin/loads/${l.id}`} className="flex min-h-[44px] min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-1">
        <span className="text-[16px] font-bold"><LoadNumber l={l} audience="staff" /></span>
        {isReturn(l) ? <span data-testid="board-return-badge" className="rounded-full bg-[#E4DCF5] px-2 py-0.5 text-[12px] font-bold text-[#3B2A78]">Return</span> : null}
        <span className="min-w-0 max-w-full text-[15px] [overflow-wrap:anywhere]">{routeOf(l)}</span>
        <span className="text-[13px] text-muted">Pickup {fmtDate(l.pickup_date)}, {pickupTimeLabel(l)}</span>
        <span className="text-[13px]">{l.carrier?.name ?? <span className="text-muted">Not assigned</span>}</span>
        {copy !== undefined && l.status === "requested" ? (
          <span data-testid="board-copy-its" className="text-[13px] font-medium">
            {copy ? `Copy ITS ${copy.number}` : <span className="text-muted">No ITS reference</span>}
          </span>
        ) : null}
        {bolPending(l) ? (
          <span className="inline-flex rounded-full bg-amber px-3 py-0.5 text-[13px] font-medium text-[#2B1500]">BOL pending</span>
        ) : null}
        {podPending(l) ? (
          <span data-testid="pod-pending" className="inline-flex rounded-full bg-amber px-3 py-0.5 text-[13px] font-medium text-[#2B1500]">POD pending</span>
        ) : null}
      </Link>
      <Disclosure testid="card-details" className="text-[14px] open:basis-full" summary={<span className="text-[14px] font-medium">Details</span>} openLabel={<span className="text-[14px] font-medium">Hide details</span>} summaryClassName="px-1">
        <dl data-testid="card-details-body" className="grid gap-x-4 gap-y-1 pb-2 sm:grid-cols-2">
          <div><dt className="inline text-muted">Pickup contact: </dt><dd className="inline break-words">{l.pickup_contact_name}{l.pickup_contact_phone ? ", " : ""}{tel(l.pickup_contact_phone)}</dd></div>
          <div><dt className="inline text-muted">Delivery contact: </dt><dd className="inline break-words">{l.delivery_contact_name}{l.delivery_contact_phone ? ", " : ""}{tel(l.delivery_contact_phone)}</dd></div>
          <div><dt className="inline text-muted">Equipment: </dt><dd className="inline">{l.equipment_size} ft{l.moffett ? ", Moffett" : ", no Moffett"}</dd></div>
          <div><dt className="inline text-muted">PO: </dt><dd className="inline break-words">{l.po_number || "None"}</dd></div>
          <div className="sm:col-span-2"><dt className="inline text-muted">Notes: </dt><dd className="inline whitespace-pre-wrap break-words">{l.notes || "None"}</dd></div>
          <div><dt className="inline text-muted">ETA: </dt><dd className="inline">{l.eta ? fmtDateTime(l.eta) : "Not set"}</dd></div>
        </dl>
      </Disclosure>
    </div>
  );
}

function OneList({ f, shown, total, copyOf, pages, moreHref }: {
  f: F; shown: BoardLoad[]; total: number; copyOf: (l: BoardLoad) => LaneReference | null | undefined;
  pages: number; moreHref: string;
}) {
  const rows = shown.slice(0, LIST_PAGE * (pages + 1));
  return (
    <section aria-label="All loads" data-testid="board-list" className="mb-6">
      <p data-testid="list-count" className="mb-2 text-[14px] text-muted">{shown.length} of {total} loads</p>
      {shown.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-line px-3 py-3 text-[13px] text-muted">No loads match these filters</p>
      ) : (
        <>
          <div className="grid gap-2 md:hidden">
            {rows.map((l) => <LoadCard key={l.id} l={l} copy={copyOf(l)} />)}
          </div>
          <div className="hidden overflow-x-auto rounded-[16px] border border-line bg-card md:block">
            <table className="w-full text-[14px]">
              <thead>
                <tr>
                  <SortHeader f={f} k="its_number" />
                  <SortHeader f={f} k="pickup_time" />
                  <SortHeader f={f} k="shipper" />
                  <SortHeader f={f} k="receiver" />
                  <SortHeader f={f} k="carrier" />
                  <SortHeader f={f} k="size" />
                  <th scope="col" className="px-3 py-2 text-left text-[13px] font-medium text-muted">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="border-t border-line">
                    <td className="px-3 py-2 font-bold">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <Link href={`/admin/loads/${l.id}`} className="inline-flex min-h-[44px] items-center underline"><LoadNumber l={l} audience="staff" /></Link>
                        {isReturn(l) ? <span data-testid="board-return-badge" className="rounded-full bg-[#E4DCF5] px-2 py-0.5 text-[12px] font-bold text-[#3B2A78]">Return</span> : null}
                      </span>
                    </td>
                    <td className="px-3 py-2">{fmtDate(l.pickup_date)}, {pickupTimeLabel(l)}</td>
                    <td className="px-3 py-2">{l.pickup?.name ?? "Unknown"}</td>
                    <td className="px-3 py-2">{l.delivery?.name ?? "Unknown"}</td>
                    <td className="px-3 py-2">{l.carrier?.name ?? "Not assigned"}</td>
                    <td className="px-3 py-2">{l.equipment_size} ft</td>
                    <td className="px-3 py-2">{STATUS_LABEL[l.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length < shown.length ? (
            <p className="mt-3 flex flex-wrap items-center gap-3 text-[14px]">
              <span data-testid="list-shown" className="text-muted">Showing {rows.length} of {shown.length}</span>
              <Link href={moreHref} data-testid="list-show-more" className="inline-flex min-h-[44px] items-center rounded-full border border-ink bg-white px-4 font-medium">Show more</Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

type Res = { data: unknown; error: { message: string } | null; count?: number | null };
const rowsOf = (r: Res): BoardLoad[] => ((r.data ?? []) as unknown as BoardLoad[]);

export default async function AdminBoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const profile = await requireStaff();
  const sp = await searchParams;
  const banner = deletedBanner({ deleted: one(sp.deleted), orphans: one(sp.orphans), logged: one(sp.logged) });
  const f = parseFilters(sp);
  const filtered = isFiltered(f);
  // R46: how many "Show older" pages of each finished band, and "Show more" pages of the one list (strict, else 0).
  const older: Record<Finished, number> = { delivered: parsePages(sp.dold), cancelled: parsePages(sp.cold) };
  const listPages = parsePages(sp.more);
  const today = easternToday();
  const cutoff = addDays(today, -WINDOW_DAYS);
  const supabase = await createClient();
  const ids = filtered && f.q ? await resolveSearchIds(supabase, f) : new Map();

  // Finished loads are never fetched whole (R46). Without a filter a band holds its pickups of the last 30 days (counted
  // first, at most FILTER_CAP) plus OLDER_PAGE more per "Show older", newest pickup first, as ONE limited query, so the
  // older pages continue exactly where the window ends. With a filter, the matching rows only (filters pushed into the
  // query, newest first, capped). The total of each finished band is a count.
  const base = (s: Finished) => supabase.from("loads").select(BOARD_SELECT).eq("status", s)
    .order("pickup_date", { ascending: false }).order("pickup_time_start", { ascending: false }).order("load_number", { ascending: false });
  const none = Promise.resolve({ data: [], error: null } as Res);
  const headCount = (s: Finished, sinceCutoff: boolean) => {
    const q = supabase.from("loads").select("id", { count: "exact", head: true }).eq("status", s);
    return sinceCutoff ? q.gte("pickup_date", cutoff) : q;
  };
  const [dCount, cCount, dWinCount, cWinCount] = await Promise.all([
    headCount("delivered", false), headCount("cancelled", false),
    filtered ? none : headCount("delivered", true), filtered ? none : headCount("cancelled", true),
  ]) as Res[];
  const windowCount: Record<Finished, number> = { delivered: dWinCount.count ?? 0, cancelled: cWinCount.count ?? 0 };
  const finishedQuery = (s: Finished) => {
    if (filtered) {
      const skip = (f.status !== "" && f.status !== s) || f.needsBol; // Needs BOL never matches a finished load
      return skip ? none : pushDown(base(s), f, today, ids).limit(FILTER_CAP);
    }
    const n = Math.min(windowCount[s], FILTER_CAP) + OLDER_PAGE * older[s];
    return n > 0 ? base(s).limit(n) : none;
  };
  const [active, dRows, cRows, openRates] = await Promise.all([
    supabase.from("loads").select(BOARD_SELECT)
      .not("status", "in", "(delivered,cancelled)")
      .order("pickup_date").order("pickup_time_start").limit(500),
    finishedQuery("delivered"), finishedQuery("cancelled"),
    supabase.from("rate_requests").select("id", { count: "exact", head: true }).eq("status", "open"),
  ]) as Res[];

  const error = active.error ?? dRows.error ?? cRows.error ?? dCount.error ?? cCount.error;
  const loads = [...rowsOf(active), ...rowsOf(dRows), ...rowsOf(cRows)];
  const finishedTotal: Record<Finished, number> = { delivered: dCount.count ?? 0, cancelled: cCount.count ?? 0 };
  // Staff only: the lane reference of every Requested load, one query (RLS: the session is staff).
  let copies = new Map<string, LaneReference>();
  let copiesOk = true;
  try {
    copies = await resolveMany(supabase, loads.filter((l) => l.status === "requested")
      .map((l) => ({ pickupId: l.pickup_location_id, deliveryId: l.delivery_location_id, size: l.equipment_size })));
  } catch {
    copiesOk = false;
  }
  const copyOf = (l: BoardLoad): LaneReference | null | undefined =>
    !copiesOk || l.status !== "requested" ? undefined
      : copies.get(scenarioKey({ pickupId: l.pickup_location_id, deliveryId: l.delivery_location_id, size: l.equipment_size })) ?? null;
  const shown = applyFilters(loads, f, today);
  const byStatus = new Map<LoadStatus, BoardLoad[]>(COLUMNS.map((s) => [s, []]));
  shown.forEach((l) => byStatus.get(l.status)?.push(l));
  // Finished bands list the most recent pickup first while the sort is the default (R46).
  if (isDefaultSort(f)) {
    for (const s of FINISHED) byStatus.set(s, sortLoads(byStatus.get(s) ?? [], { sort: "pickup_time", dir: "desc" }));
  }
  const loadedBy = (s: LoadStatus) => loads.filter((l) => l.status === s).length;
  const totalOf = (s: LoadStatus) => (isFinished(s) ? finishedTotal[s] : loadedBy(s));
  // The options come from the loads on the board; a chosen carrier, shipper or receiver that only old (not fetched) loads
  // use is added by name, so its chip and the select never fall back to "Unknown" or "All" (R46).
  type Named = { id: string; name: string };
  const pickedLocs = [f.shipper, f.receiver].filter(Boolean);
  const pickedCarrier = f.carrier && f.carrier !== "none" ? f.carrier : "";
  const [locNames, carNames] = await Promise.all([
    pickedLocs.length > 0 ? supabase.from("locations").select("id,name").in("id", pickedLocs) : none,
    pickedCarrier ? supabase.from("carriers").select("id,name").eq("id", pickedCarrier) : none,
  ]) as Res[];
  const named = (r: Res, id: string) => (id ? ((r.data ?? []) as Named[]).filter((x) => x.id === id) : []);
  const carrierOpts = distinct([
    ...loads.flatMap((l) => (l.carrier_id && l.carrier ? [{ id: l.carrier_id, name: l.carrier.name }] : [])), ...named(carNames, pickedCarrier),
  ]);
  const shipperOpts = distinct([...loads.map((l) => ({ id: l.pickup_location_id, name: l.pickup?.name })), ...named(locNames, f.shipper)]);
  const receiverOpts = distinct([...loads.map((l) => ({ id: l.delivery_location_id, name: l.delivery?.name })), ...named(locNames, f.receiver)]);
  const count = (s: LoadStatus) => {
    const n = (byStatus.get(s) ?? []).length;
    return filtered ? `${n} of ${totalOf(s)}` : String(isFinished(s) ? totalOf(s) : n);
  };
  // Links keep the filters and the other counters; `patch` changes one counter.
  const href = (patch: Record<string, number>) =>
    `/admin${withParams(toQuery(f), { dold: older.delivered, cold: older.cancelled, more: listPages, ...patch })}`;

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <PageTitle>Load board</PageTitle>
      <p className="mb-3">
        <Link href="/admin/rates" data-testid="board-rates-link" className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-line bg-white px-4 text-[14px] font-medium">
          Open rate requests
          <span data-testid="board-rates-count" className="rounded-full bg-mint px-2 py-0.5 text-[13px]">{openRates.count ?? 0}</span>
        </Link>
      </p>
      {banner ? <div className="mb-4" data-testid="deleted-banner"><Notice tone={banner.tone}>{banner.text}</Notice></div> : null}
      {error ? <div className="mb-4"><Notice tone="error">Could not load the board: {error.message}</Notice></div> : null}
      <p className="mb-3 text-[13px] text-muted">Delivered and cancelled show pickups from the last 30 days (Show older for more); a search or filter looks through all of them. Times are Eastern (ET).</p>
      <BoardFilters f={f} carriers={carrierOpts} shippers={shipperOpts} receivers={receiverOpts} />
      {f.view === "list" ? (
        <OneList f={f} shown={shown} total={loads.length} copyOf={copyOf} pages={listPages} moreHref={href({ more: listPages + 1 })} />
      ) : null}
      {f.view === "status" ? <nav aria-label="Jump to status" className="mb-4 flex flex-wrap gap-2">
        {COLUMNS.map((s) => {
          const n = (byStatus.get(s) ?? []).length;
          return (
            <a
              key={s}
              href={`#status-${s}`}
              className={`inline-flex min-h-[44px] items-center gap-2 rounded-full border px-4 text-[14px] font-medium ${
                n > 0 ? "border-ink bg-white text-ink" : "border-line bg-white/60 text-muted"
              }`}
            >
              {STATUS_LABEL[s]}
              <span className="rounded-full bg-mint px-2 py-0.5 text-[13px]">{count(s)}</span>
            </a>
          );
        })}
      </nav> : null}
      {f.view === "status" ? <div className="space-y-4">
        {COLUMNS.map((s) => {
          const list = byStatus.get(s) ?? [];
          const first = list.slice(0, BAND_PAGE);
          const rest = list.slice(BAND_PAGE);
          // Open: with a filter, the bands that hold a match; without, every band but Delivered and Cancelled (and a
          // finished band whose older loads were just asked for).
          const open = filtered ? list.length > 0 : !isFinished(s) || older[s] > 0;
          const fin = isFinished(s) ? s : null;
          return (
            <section key={s} id={`status-${s}`} aria-label={STATUS_LABEL[s]} data-testid={`band-${s}`} className="scroll-mt-4">
              <Disclosure
                open={open}
                testid={`band-toggle-${s}`}
                summaryClassName="text-[18px] font-bold"
                summary={
                  <h2 className="flex items-center gap-2 text-[18px] font-bold">
                    <span>{STATUS_LABEL[s]}</span>
                    <span data-testid={`band-count-${s}`} className="rounded-full bg-white px-2.5 py-0.5 text-[14px] text-muted">{count(s)}</span>
                  </h2>
                }
              >
                <div className="mt-2">
                  {fin && !filtered ? (
                    <p data-testid={`band-window-${s}`} className="mb-2 text-[13px] text-muted">
                      Pickups from the last {WINDOW_DAYS} days{older[fin] > 0 ? " and older" : ""}: {loadedBy(s)} of {finishedTotal[fin]} shown.
                    </p>
                  ) : null}
                  {list.length === 0 ? (
                    <p className="rounded-[16px] border border-dashed border-line px-3 py-3 text-[13px] text-muted">No loads</p>
                  ) : (
                    <ul className="space-y-2">
                      {first.map((l) => <li key={l.id}><LoadCard l={l} copy={copyOf(l)} /></li>)}
                    </ul>
                  )}
                  {rest.length > 0 ? (
                    <Disclosure
                      testid={`band-all-${s}`}
                      className="mt-2"
                      summaryClassName="px-2 text-[14px] font-medium underline"
                      summary={`Show all ${list.length}`}
                      openLabel={`Show the first ${BAND_PAGE} only`}
                    >
                      <ul className="mt-2 space-y-2">
                        {rest.map((l) => <li key={l.id}><LoadCard l={l} copy={copyOf(l)} /></li>)}
                      </ul>
                    </Disclosure>
                  ) : null}
                  {fin && !filtered && loadedBy(s) < finishedTotal[fin] && older[fin] < 20 ? (
                    <Link
                      href={href(fin === "delivered" ? { dold: older.delivered + 1 } : { cold: older.cancelled + 1 })}
                      data-testid={`band-older-${s}`}
                      className="mt-2 inline-flex min-h-[44px] items-center rounded-full border border-ink bg-white px-4 text-[14px] font-medium"
                    >
                      Show older ({OLDER_PAGE} more)
                    </Link>
                  ) : null}
                </div>
              </Disclosure>
            </section>
          );
        })}
      </div> : null}
    </Shell>
  );
}
