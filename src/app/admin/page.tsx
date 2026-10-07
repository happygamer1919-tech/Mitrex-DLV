import Link from "next/link";
import { Shell } from "@/components/Shell";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Notice, PageTitle } from "@/components/ui";
import { LoadNumber } from "@/components/LoadNumber";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import { deletedBanner } from "@/lib/admin/delete-load";
import { resolveMany, scenarioKey, type LaneReference } from "@/lib/admin/lane-reference";
import { BoardFilters, SORT_LABEL } from "@/components/admin/BoardFilters";
import { applyFilters, easternToday, isFiltered, parseFilters, toQuery, type BoardFilters as F, type SortKey } from "@/lib/admin/board-filters";
import { BOARD_SELECT, bolPending, pickupTimeLabel, podPending, routeOf, type BoardLoad } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

const COLUMNS: LoadStatus[] = [
  "requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered", "cancelled",
];

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

function LoadCard({ l, copy }: { l: BoardLoad; copy: LaneReference | null | undefined }) {
  return (
    <Link
      href={`/admin/loads/${l.id}`}
      className="block rounded-[16px] border border-line bg-card p-3 hover:border-ink"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[16px] font-bold"><LoadNumber l={l} audience="staff" /></span>
        <span className="text-[13px] text-muted">{l.equipment_size} ft</span>
      </div>
      <p className="mt-1 break-words text-[15px]">{routeOf(l)}</p>
      <p className="mt-1 text-[13px] text-muted">
        Pickup {fmtDate(l.pickup_date)}, {pickupTimeLabel(l)}
      </p>
      <p className="mt-1 text-[13px]">
        <span className="text-muted">Carrier: </span>{l.carrier?.name ?? "Not assigned"}
      </p>
      {l.eta ? <p className="mt-1 text-[13px]"><span className="text-muted">ETA: </span>{fmtDateTime(l.eta)}</p> : null}
      {copy !== undefined && l.status === "requested" ? (
        <p data-testid="board-copy-its" className="mt-1 text-[13px] font-medium">
          {copy ? `Copy ITS ${copy.number}` : <span className="text-muted">No ITS reference</span>}
        </p>
      ) : null}
      {bolPending(l) ? (
        <span className="mt-2 inline-flex rounded-full bg-amber px-3 py-1 text-[13px] font-medium text-[#2B1500]">
          BOL pending
        </span>
      ) : null}
      {podPending(l) ? (
        <span data-testid="pod-pending" className="mt-2 inline-flex rounded-full bg-amber px-3 py-1 text-[13px] font-medium text-[#2B1500]">
          POD pending
        </span>
      ) : null}
    </Link>
  );
}

function OneList({ f, shown, total, copyOf }: { f: F; shown: BoardLoad[]; total: number; copyOf: (l: BoardLoad) => LaneReference | null | undefined }) {
  return (
    <section aria-label="All loads" data-testid="board-list" className="mb-6">
      <p data-testid="list-count" className="mb-2 text-[14px] text-muted">{shown.length} of {total} loads</p>
      {shown.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-line px-3 py-3 text-[13px] text-muted">No loads match these filters</p>
      ) : (
        <>
          <div className="grid gap-3 md:hidden">
            {shown.map((l) => <LoadCard key={l.id} l={l} copy={copyOf(l)} />)}
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
                {shown.map((l) => (
                  <tr key={l.id} className="border-t border-line">
                    <td className="px-3 py-2 font-bold"><Link href={`/admin/loads/${l.id}`} className="inline-flex min-h-[44px] items-center underline"><LoadNumber l={l} audience="staff" /></Link></td>
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
        </>
      )}
    </section>
  );
}

export default async function AdminBoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const profile = await requireStaff();
  const sp = await searchParams;
  const banner = deletedBanner({ deleted: one(sp.deleted), orphans: one(sp.orphans), logged: one(sp.logged) });
  const f = parseFilters(sp);
  const filtered = isFiltered(f);
  const supabase = await createClient();
  const since = new Date(Date.now() - 14 * 86400000).toISOString();

  const [active, finished, openRates] = await Promise.all([
    supabase.from("loads").select(BOARD_SELECT)
      .not("status", "in", "(delivered,cancelled)")
      .order("pickup_date").order("pickup_time_start").limit(500),
    supabase.from("loads").select(BOARD_SELECT)
      .in("status", ["delivered", "cancelled"]).gte("updated_at", since)
      .order("updated_at", { ascending: false }).limit(200),
    supabase.from("rate_requests").select("id", { count: "exact", head: true }).eq("status", "open"),
  ]);

  const error = active.error ?? finished.error;
  const loads = [...((active.data ?? []) as unknown as BoardLoad[]), ...((finished.data ?? []) as unknown as BoardLoad[])];
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
  const today = easternToday();
  const shown = applyFilters(loads, f, today);
  const byStatus = new Map<LoadStatus, BoardLoad[]>(COLUMNS.map((s) => [s, []]));
  shown.forEach((l) => byStatus.get(l.status)?.push(l));
  const totalBy = new Map<LoadStatus, number>(COLUMNS.map((s) => [s, loads.filter((l) => l.status === s).length]));
  const carrierOpts = distinct(loads.flatMap((l) => (l.carrier_id && l.carrier ? [{ id: l.carrier_id, name: l.carrier.name }] : [])));
  const shipperOpts = distinct(loads.map((l) => ({ id: l.pickup_location_id, name: l.pickup?.name })));
  const receiverOpts = distinct(loads.map((l) => ({ id: l.delivery_location_id, name: l.delivery?.name })));
  const count = (s: LoadStatus) => {
    const n = (byStatus.get(s) ?? []).length;
    return filtered ? `${n} of ${totalBy.get(s) ?? 0}` : String(n);
  };

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
      <p className="mb-3 text-[13px] text-muted">Delivered and cancelled loads show the last 14 days. Times are Eastern (ET).</p>
      <BoardFilters f={f} carriers={carrierOpts} shippers={shipperOpts} receivers={receiverOpts} />
      {f.view === "list" ? (
        <OneList f={f} shown={shown} total={loads.length} copyOf={copyOf} />
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
      {f.view === "status" ? <div className="space-y-6">
        {COLUMNS.map((s) => {
          const list = byStatus.get(s) ?? [];
          return (
            <section key={s} id={`status-${s}`} aria-label={STATUS_LABEL[s]} className="scroll-mt-4">
              <h2 className="mb-2 flex items-center gap-2 text-[18px] font-bold">
                <span>{STATUS_LABEL[s]}</span>
                <span className="rounded-full bg-white px-2.5 py-0.5 text-[14px] text-muted">{count(s)}</span>
              </h2>
              {list.length === 0 ? (
                <p className="rounded-[16px] border border-dashed border-line px-3 py-3 text-[13px] text-muted">No loads</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  {list.map((l) => <LoadCard key={l.id} l={l} copy={copyOf(l)} />)}
                </div>
              )}
            </section>
          );
        })}
      </div> : null}
    </Shell>
  );
}
