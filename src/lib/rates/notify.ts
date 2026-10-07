import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { rateLane, type RateRequest } from "./validate";

// Plain text emails (no HTML), so user text cannot inject markup. Control characters are stripped from anything that
// goes into a subject line. Both functions never throw: the request or the rate has already been saved.

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
const site = () => (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");

// ONE email to every ACTIVE staff_admin (not csr) when a customer asks for a rate.
export async function notifyAdminsOfRateRequest(r: RateRequest): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const [{ data: admins }, { data: cust }, { data: who }] = await Promise.all([
      admin.from("profiles").select("email").eq("is_active", true).eq("role", "staff_admin"),
      admin.from("customers").select("name").eq("id", r.customer_id).maybeSingle(),
      admin.from("profiles").select("email,full_name").eq("id", r.requested_by).maybeSingle(),
    ]);
    const to = ((admins ?? []) as { email: string }[]).map((a) => a.email).filter(Boolean);
    if (to.length === 0) return false;
    const customer = (cust as { name: string } | null)?.name ?? "Unknown customer";
    const person = who as { email: string; full_name: string | null } | null;
    const lines = [
      `A customer asked for a rate (${r.ref}). This is a rate request, not a load.`,
      "",
      `Request: ${r.ref}`,
      `Customer: ${customer}${person ? ` (requested by ${person.full_name ? `${person.full_name}, ` : ""}${person.email})` : ""}`,
      `Lane: ${r.pickup_city}, ${r.pickup_state} to ${r.delivery_city}, ${r.delivery_state}`,
      `Equipment: ${r.equipment_size} ft`,
      `Weight: ${r.weight_lbs ? `${r.weight_lbs} lbs` : "not given"}`,
      `Dimensions: ${r.dims ?? "not given"}`,
      `Notes: ${r.notes ?? "none"}`,
      "",
      `Enter the rate in the portal: ${site()}/admin/rates/${r.id}`,
    ];
    return await sendEmail(to, `Rate request ${r.ref}: ${oneLine(`${r.pickup_city}, ${r.pickup_state}`)} to ${oneLine(`${r.delivery_city}, ${r.delivery_state}`)}, ${r.equipment_size} ft`, lines.join("\n"));
  } catch {
    return false;
  }
}

// ONE email to every ACTIVE customer user of the request's customer when staff enter the rate. The email says the rate
// is in the app and carries NO amount, currency or quote notes: the rate lives in the app only. A correction of an
// existing rate sends the same kind of message with a different subject.
export async function notifyCustomerOfRate(r: Pick<RateRequest, "id" | "ref" | "customer_id" | "pickup_city" | "pickup_state" | "delivery_city" | "delivery_state" | "equipment_size">, corrected: boolean): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("profiles").select("email").eq("is_active", true).eq("role", "customer").eq("customer_id", r.customer_id);
    const to = ((data ?? []) as { email: string }[]).map((p) => p.email).filter(Boolean);
    if (to.length === 0) return false;
    const lines = [
      corrected ? `The rate for ${r.ref} was updated and is in the app.` : `Your rate is in the app (${r.ref}).`,
      "",
      `Lane: ${rateLane(r)}`,
      "",
      `See it on the Rates page: ${site()}/rates`,
    ];
    const subject = corrected ? `Your rate was updated in the app (${r.ref})` : `Your rate is ready in the app (${r.ref})`;
    return await sendEmail(to, subject, lines.join("\n"));
  } catch {
    return false;
  }
}
