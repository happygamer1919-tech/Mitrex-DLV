import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { fmtSlot } from "@/lib/format";
import { addressWithName } from "@/lib/address";

type Loc = { name: string; address_line: string; city: string; province: string; postal_code: string | null } | null;

function addr(l: Loc): string {
  if (!l) return "Unknown";
  return addressWithName(l);
}

// Emails every user of the load's carrier. Call ONLY after the actor was verified as staff.
// Returns the number of recipients addressed (0 when nothing was sent).
export async function notifyCarrierAssigned(loadId: string): Promise<number> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("loads")
    .select(
      "id,load_number,carrier_id,pickup_timing,pickup_date,pickup_time_start,pickup_time_end," +
      "delivery_timing,delivery_date,delivery_time_start,delivery_time_end," +
      "pickup_contact_name,pickup_contact_phone,delivery_contact_name,delivery_contact_phone," +
      "pickup:locations!pickup_location_id(name,address_line,city,province,postal_code)," +
      "delivery:locations!delivery_location_id(name,address_line,city,province,postal_code)",
    )
    .eq("id", loadId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const l = data as any;
  if (!l || !l.carrier_id) return 0;

  const admin = createAdminClient();
  const { data: users } = await admin.from("profiles").select("email").eq("carrier_id", l.carrier_id).eq("is_active", true);
  const to = ((users ?? []) as { email: string }[]).map((u) => u.email).filter(Boolean);
  if (to.length === 0) return 0;

  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  const body = [
    `Load ${l.load_number} has been assigned to you.`,
    "",
    "PICKUP",
    addr(l.pickup),
    fmtSlot(l.pickup_timing, l.pickup_date, l.pickup_time_start, l.pickup_time_end),
    `Contact: ${l.pickup_contact_name}, ${l.pickup_contact_phone}`,
    "",
    "DELIVERY",
    addr(l.delivery),
    fmtSlot(l.delivery_timing, l.delivery_date, l.delivery_time_start, l.delivery_time_end),
    `Contact: ${l.delivery_contact_name}, ${l.delivery_contact_phone}`,
    "",
    `Open the load: ${site}/my-loads/${l.id}`,
  ].join("\n");

  const ok = await sendEmail(to, `Load ${l.load_number} assigned to you`, body);
  return ok ? to.length : 0;
}
