import { createClient } from "@/lib/supabase/server";
import { easternLocalToIso, isoToEasternLocal } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/types";
import { addDays, isValidDay } from "@/lib/admin/cal";
import { csvRow } from "@/lib/admin/csv";
import { itsOrRef } from "@/lib/load-number";

// The loads CSV of R27, shared by the staff export (/admin/export/csv, every load) and Maria's export
// (/loads/export/csv, R46). Both read through the SESSION client, so RLS decides which rows come back: staff read every
// load, a customer only the loads of her own customer (and the caller narrows to that customer again). No lane
// reference is ever selected.

const COLUMNS = [
  "load_number", "request_ref", "created_at", "pickup_location", "delivery_location", "equipment_size", "moffett",
  "weight_lbs", "pieces", "po_number", "pickup_timing", "pickup_date", "pickup_time_start",
  "pickup_time_end", "delivery_timing", "delivery_date", "delivery_time_start", "delivery_time_end",
  "carrier", "status", "eta", "delivered_at",
];

const SELECT =
  "load_number,its_load_number,created_at,equipment_size,moffett,weight_lbs,pieces,po_number,pickup_timing,pickup_date," +
  "pickup_time_start,pickup_time_end,delivery_timing,delivery_date,delivery_time_start,delivery_time_end," +
  "status,eta,delivered_at," +
  "pickup:locations!pickup_location_id(name),delivery:locations!delivery_location_id(name),carrier:carriers(name)";

const et = (iso: string | null) => (iso ? isoToEasternLocal(iso).replace("T", " ") : "");
const hm = (t: string | null) => (t ? t.slice(0, 5) : "");

export function text(body: string, status: number) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function loadsCsv(request: Request, opts: { customerId?: string; filePrefix: string }): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  const by = sp.get("by") === "created_at" ? "created_at" : "pickup_date";
  if (!isValidDay(from) || !isValidDay(to)) return text("from and to must be dates (YYYY-MM-DD).", 400);
  if (from > to) return text("from must be on or before to.", 400);

  const statuses = sp.getAll("status").flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  if (statuses.some((s) => !Object.hasOwn(STATUS_LABEL, s))) return text("Unknown status value.", 400);

  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    let q = supabase.from("loads").select(SELECT);
    if (by === "pickup_date") {
      q = q.gte("pickup_date", from).lte("pickup_date", to);
    } else {
      q = q.gte("created_at", easternLocalToIso(`${from}T00:00`))
        .lt("created_at", easternLocalToIso(`${addDays(to, 1)}T00:00`));
    }
    if (statuses.length > 0) q = q.in("status", statuses);
    if (opts.customerId) q = q.eq("customer_id", opts.customerId);
    const { data, error } = await q.order(by).order("load_number").range(offset, offset + 999);
    if (error) return text(`Export failed: ${error.message}`, 500);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const lines = [csvRow(COLUMNS)];
  for (const l of rows) {
    lines.push(csvRow([
      itsOrRef(l), l.load_number, et(l.created_at), l.pickup?.name, l.delivery?.name, l.equipment_size,
      l.moffett ? "yes" : "no", l.weight_lbs, l.pieces, l.po_number, l.pickup_timing, l.pickup_date,
      hm(l.pickup_time_start), hm(l.pickup_time_end), l.delivery_timing, l.delivery_date,
      hm(l.delivery_time_start), hm(l.delivery_time_end), l.carrier?.name, l.status, et(l.eta), et(l.delivered_at),
    ]));
  }

  const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${opts.filePrefix}-${from}-${to}.csv"`,
      "cache-control": "no-store",
    },
  });
}
