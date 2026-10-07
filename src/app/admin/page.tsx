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
import { BOARD_SELECT, bolPending, pickupTimeLabel, podPending, routeOf, type BoardLoad } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

const COLUMNS: LoadStatus[] = [
  "requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered", "cancelled",
];

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

export default async function AdminBoardPage({ searchParams }: { searchParams: Promise<{ deleted?: string; orphans?: string; logged?: string }> }) {
  const profile = await requireStaff();
  const banner = deletedBanner(await searchParams);
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
  const byStatus = new Map<LoadStatus, BoardLoad[]>(COLUMNS.map((s) => [s, []]));
  loads.forEach((l) => byStatus.get(l.status)?.push(l));

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
      <nav aria-label="Jump to status" className="mb-4 flex flex-wrap gap-2">
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
              <span className="rounded-full bg-mint px-2 py-0.5 text-[13px]">{n}</span>
            </a>
          );
        })}
      </nav>
      <div className="space-y-6">
        {COLUMNS.map((s) => {
          const list = byStatus.get(s) ?? [];
          return (
            <section key={s} id={`status-${s}`} aria-label={STATUS_LABEL[s]} className="scroll-mt-4">
              <h2 className="mb-2 flex items-center gap-2 text-[18px] font-bold">
                <span>{STATUS_LABEL[s]}</span>
                <span className="rounded-full bg-white px-2.5 py-0.5 text-[14px] text-muted">{list.length}</span>
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
      </div>
    </Shell>
  );
}
