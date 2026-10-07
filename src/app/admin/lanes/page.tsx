import { Shell } from "@/components/Shell";
import { Notice, PageTitle } from "@/components/ui";
import { LaneManager, type LaneRow, type LocOption } from "@/components/admin/LaneManager";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime } from "@/lib/format";
import { UUID } from "@/lib/admin/errors";
import { LANE_SIZES } from "@/lib/admin/lane-reference";

export const dynamic = "force-dynamic";

type Raw = {
  id: string; pickup_location_id: string; delivery_location_id: string; equipment_size: number;
  its_reference_load: string; note: string | null; updated_at: string; updated_by: string | null;
  pickup: { name: string; requires_moffett: boolean } | null;
  delivery: { name: string; requires_moffett: boolean } | null;
};

// STAFF ONLY (requireStaff, and RLS on lane_references refuses everyone else again).
export default async function LanesPage({ searchParams }: { searchParams: Promise<{ pickup?: string; delivery?: string; size?: string }> }) {
  const profile = await requireStaff();
  const sp = await searchParams;
  const sb = await createClient();
  const [lanes, locs] = await Promise.all([
    sb.from("lane_references")
      .select("id,pickup_location_id,delivery_location_id,equipment_size,its_reference_load,note,updated_at,updated_by," +
        "pickup:locations!pickup_location_id(name,requires_moffett),delivery:locations!delivery_location_id(name,requires_moffett)")
      .limit(5000),
    sb.from("locations").select("id,name,is_active,requires_moffett").order("name"),
  ]);
  const raw = (lanes.data ?? []) as unknown as Raw[];
  const actorIds = [...new Set(raw.map((r) => r.updated_by).filter((v): v is string => !!v))];
  const actors = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data } = await sb.from("profiles").select("id,email,full_name").in("id", actorIds);
    ((data ?? []) as { id: string; email: string; full_name: string | null }[]).forEach((p) => actors.set(p.id, p.full_name || p.email));
  }
  const rows: LaneRow[] = raw.map((r) => ({
    id: r.id,
    pickupId: r.pickup_location_id, deliveryId: r.delivery_location_id,
    pickup: r.pickup?.name ?? "Unknown", delivery: r.delivery?.name ?? "Unknown",
    size: r.equipment_size, number: r.its_reference_load, note: r.note,
    moffett: Boolean(r.pickup?.requires_moffett || r.delivery?.requires_moffett), // derived, never stored
    updated: `${r.updated_by ? actors.get(r.updated_by) ?? "Unknown user" : "System"}, ${fmtDateTime(r.updated_at)}`,
  }));
  const locations = (locs.data ?? []) as LocOption[];

  const sizes = LANE_SIZES as readonly number[];
  const size = Number(sp.size);
  const pickup = UUID.test(sp.pickup ?? "") ? sp.pickup! : "";
  const delivery = UUID.test(sp.delivery ?? "") ? sp.delivery! : "";
  const prefill = pickup || delivery || sizes.includes(size)
    ? { pickup, delivery, size: sizes.includes(size) ? size : 26 }
    : null;

  const error = lanes.error ?? locs.error;
  return (
    <Shell profile={profile}>
      <PageTitle>Lanes</PageTitle>
      <p className="mb-4 max-w-2xl text-[15px] text-muted">
        For each repeat lane, which old ITS load to copy. Staff only: customers and carriers never see this page or these numbers.
      </p>
      {error ? <div className="mb-4"><Notice tone="error">Could not load lanes: {error.message}</Notice></div> : null}
      <LaneManager lanes={rows} locations={locations} prefill={prefill} />
    </Shell>
  );
}
