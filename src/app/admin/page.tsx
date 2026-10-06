import Link from "next/link";
import { Shell } from "@/components/Shell";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Notice, PageTitle } from "@/components/ui";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import { BOARD_SELECT, bolPending, pickupTimeLabel, podPending, routeOf, type BoardLoad } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

const COLUMNS: LoadStatus[] = [
  "requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered", "cancelled",
];

function LoadCard({ l }: { l: BoardLoad }) {
  return (
    <Link
      href={`/admin/loads/${l.id}`}
      className="block rounded-[16px] border border-line bg-card p-3 hover:border-ink"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[16px] font-bold">{l.load_number}</span>
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

export default async function AdminBoardPage() {
  const profile = await requireStaff();
  const supabase = await createClient();
  const since = new Date(Date.now() - 14 * 86400000).toISOString();

  const [active, finished] = await Promise.all([
    supabase.from("loads").select(BOARD_SELECT)
      .not("status", "in", "(delivered,cancelled)")
      .order("pickup_date").order("pickup_time_start").limit(500),
    supabase.from("loads").select(BOARD_SELECT)
      .in("status", ["delivered", "cancelled"]).gte("updated_at", since)
      .order("updated_at", { ascending: false }).limit(200),
  ]);

  const error = active.error ?? finished.error;
  const loads = [...((active.data ?? []) as unknown as BoardLoad[]), ...((finished.data ?? []) as unknown as BoardLoad[])];
  const byStatus = new Map<LoadStatus, BoardLoad[]>(COLUMNS.map((s) => [s, []]));
  loads.forEach((l) => byStatus.get(l.status)?.push(l));

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <PageTitle>Load board</PageTitle>
      {error ? <div className="mb-4"><Notice tone="error">Could not load the board: {error.message}</Notice></div> : null}
      <p className="mb-3 text-[13px] text-muted">Delivered and cancelled loads show the last 14 days. Times are Eastern (ET).</p>
      <div className="-mx-4 overflow-x-auto px-4 pb-4">
        <div className="flex gap-3">
          {COLUMNS.map((s) => {
            const list = byStatus.get(s) ?? [];
            return (
              <section key={s} aria-label={STATUS_LABEL[s]} className="w-[280px] shrink-0">
                <h2 className="mb-2 flex items-center justify-between text-[15px] font-bold">
                  <span>{STATUS_LABEL[s]}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[13px] text-muted">{list.length}</span>
                </h2>
                <div className="space-y-3">
                  {list.length === 0 ? (
                    <p className="rounded-[16px] border border-dashed border-line px-3 py-4 text-[13px] text-muted">No loads</p>
                  ) : list.map((l) => <LoadCard key={l.id} l={l} />)}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}
