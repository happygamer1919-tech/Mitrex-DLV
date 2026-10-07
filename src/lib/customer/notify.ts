import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { fmtSlot } from "@/lib/format";
import { addLanePath, laneLabel, resolve } from "@/lib/admin/lane-reference";
import { loadNumberSummary } from "./bulk";
import type { LoadFormValues } from "./validate";

// Emails every staff user about a new request. Never throws: the booking has already succeeded.
// Call only after the actor was verified as a customer.
export async function notifyStaffOfRequest(args: {
  loads: { id: string; loadNumber: string }[]; // one booking, one email, however many trucks
  pickupName: string;
  deliveryName: string;
  moffett: boolean;
  values: LoadFormValues;
  customerName: string | null;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("profiles")
      .select("email")
      .eq("is_active", true)
      .in("role", ["staff_admin", "staff_csr"]);
    const to = ((data ?? []) as { email: string }[]).map((r) => r.email).filter(Boolean);
    if (to.length === 0) return;
    const v = args.values;
    const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
    const many = args.loads.length > 1;
    const numbers = args.loads.map((l) => l.loadNumber);
    const laneLines = await laneReferenceLines(admin, args, site);
    const lines = [
      `${many ? `${args.loads.length} new loads were` : "A new load was"} requested${args.customerName ? ` by ${args.customerName}` : ""}.`,
      "",
      ...(many
        ? [`Loads (${args.loads.length} trucks, same details, one request ref each):`, ...args.loads.map((l) => `Request ${l.loadNumber}: ${site}/admin/loads/${l.id}`)]
        : [`Request ref: ${numbers[0]}`]),
      many
        ? "ITS load numbers: not assigned yet. Enter one per truck when you book each load."
        : "ITS load number: not assigned yet. Enter it when you book.",
      ...laneLines,
      `Route: ${args.pickupName} to ${args.deliveryName}`,
      `Equipment: ${v.equipment_size} ft${args.moffett ? ", Moffett required" : ""}`,
      `Pickup: ${fmtSlot(v.pickup_timing, v.pickup_date, v.pickup_time_start, v.pickup_time_end || null)}`,
      `Delivery: ${fmtSlot(v.delivery_timing, v.delivery_date, v.delivery_time_start, v.delivery_time_end || null)}`,
      `Pickup contact: ${v.pickup_contact_name.trim()}, ${v.pickup_contact_phone.trim()}`,
      `Delivery contact: ${v.delivery_contact_name.trim()}, ${v.delivery_contact_phone.trim()}`,
    ];
    if (v.weight_lbs.trim()) lines.push(`Weight: ${v.weight_lbs.trim()} lbs`);
    if (v.pieces.trim()) lines.push(`Pieces: ${v.pieces.trim()}`);
    if (v.po_number.trim()) lines.push(`PO number: ${v.po_number.trim()}`);
    if (v.notes.trim()) lines.push(`Notes: ${v.notes.trim()}`);
    if (!many) lines.push("", `Open in the portal: ${site}/admin/loads/${args.loads[0].id}`);
    const subject = many
      ? `New loads requested (Request ${loadNumberSummary(numbers)}, ${numbers.length} trucks)`
      : `New load requested (Request ${numbers[0]})`;
    await sendEmail(to, subject, lines.join("\n"));
  } catch {
    // swallow: notification failure must not fail the booking
  }
}

// STAFF EMAIL ONLY. The ITS load to copy for the booking's scenario(s), read with the service role client after the
// load was created. One line per distinct scenario (a multi-truck booking has identical trucks, so one line). It
// never appears in any customer or carrier message.
async function laneReferenceLines(
  admin: ReturnType<typeof createAdminClient>,
  args: { pickupName: string; deliveryName: string; values: LoadFormValues },
  site: string,
): Promise<string[]> {
  const v = args.values;
  const size = Number(v.equipment_size);
  const scenarios = [{ pickupId: v.pickup_location_id, deliveryId: v.delivery_location_id, size, pickupName: args.pickupName, deliveryName: args.deliveryName }];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const sc of scenarios) {
    const key = `${sc.pickupId}|${sc.deliveryId}|${sc.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const ref = await resolve(admin, sc.pickupId, sc.deliveryId, sc.size);
      lines.push(ref
        ? `ITS load to copy: ${ref.number} (${laneLabel(sc.pickupName, sc.deliveryName, sc.size)})`
        : `No ITS reference for this lane and size yet. Add it: ${site}${addLanePath(sc)}`);
    } catch {
      lines.push(`ITS load to copy: lookup failed, check ${site}/admin/lanes`);
    }
  }
  return lines;
}
