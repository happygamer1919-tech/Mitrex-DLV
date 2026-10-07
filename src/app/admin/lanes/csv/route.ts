import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isStaff } from "@/lib/types";
import { lanesToCsv, type LaneCsvRow } from "@/lib/admin/lane-csv";

export const dynamic = "force-dynamic";

function text(body: string, status: number) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// Staff only. Columns: shipper, receiver, truck_size, load_to_copy, note. Cells that start with = + - @ are protected
// against spreadsheet formula injection (see lib/admin/csv.ts).
export async function GET() {
  const profile = await getSessionProfile();
  if (!profile) return text("Sign in required.", 401);
  if (!isStaff(profile.role)) return text("Staff only.", 403);
  const sb = await createClient();
  const { data, error } = await sb.from("lane_references")
    .select("equipment_size,its_reference_load,note,pickup:locations!pickup_location_id(name),delivery:locations!delivery_location_id(name)")
    .limit(5000);
  if (error) return text(`Export failed: ${error.message}`, 500);
  const rows = ((data ?? []) as unknown as {
    equipment_size: number; its_reference_load: string; note: string | null;
    pickup: { name: string } | null; delivery: { name: string } | null;
  }[]).map((r): LaneCsvRow => ({
    shipper: r.pickup?.name ?? "", receiver: r.delivery?.name ?? "", truck_size: r.equipment_size,
    load_to_copy: r.its_reference_load, note: r.note,
  }));
  rows.sort((a, b) => a.shipper.localeCompare(b.shipper) || a.receiver.localeCompare(b.receiver) || a.truck_size - b.truck_size);
  return new Response("﻿" + lanesToCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="dlv-lane-references.csv"',
      "cache-control": "no-store",
    },
  });
}
