import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, type EmailAttachment } from "@/lib/email";
import { fmtSlot } from "@/lib/format";
import { addressWithName } from "@/lib/address";
import { itsOrRef } from "@/lib/load-number";

type Loc = { name: string; address_line: string; city: string; province: string; postal_code: string | null } | null;

function addr(l: Loc): string {
  if (!l) return "Unknown";
  return addressWithName(l);
}

const siteUrl = () => (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");

// Emails every user of the load's carrier. Call ONLY after the actor was verified as staff.
// Returns the number of recipients addressed (0 when nothing was sent).
export async function notifyCarrierAssigned(loadId: string): Promise<number> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("loads")
    .select(
      "id,load_number,its_load_number,carrier_id,pickup_timing,pickup_date,pickup_time_start,pickup_time_end," +
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

  // Carriers only ever see booked loads, so the ITS number. A legacy load without one falls back to the request ref.
  const num = itsOrRef(l);
  const body = [
    `Load ${num} has been assigned to you.`,
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
    `Open the load: ${siteUrl()}/my-loads/${l.id}`,
  ].join("\n");

  const ok = await sendEmail(to, `Load ${num} assigned to you`, body);
  return ok ? to.length : 0;
}

// ---- Customer emails (DLV-025): one booking confirmation, one follow-up per BOL uploaded after booking. ----

export const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic",
};

const extOf = (path: string) => (path.split(".").pop() ?? "pdf").toLowerCase();

// Attachment file name: BOL-<ITS number>.<ext>; a second and later BOL gets _2, _3.
export function bolFilename(num: string, path: string, index: number): string {
  return `BOL-${num}${index > 0 ? `_${index + 1}` : ""}.${extOf(path)}`;
}

// Downloads the BOL files with the service role client. Returns null when a file cannot be read.
async function downloadBols(paths: string[], num: string): Promise<EmailAttachment[] | null> {
  const admin = createAdminClient();
  const out: EmailAttachment[] = [];
  for (let i = 0; i < paths.length; i++) {
    const { data, error } = await admin.storage.from("documents").download(paths[i]);
    if (error || !data) return null;
    out.push({
      filename: bolFilename(num, paths[i], i),
      content: Buffer.from(await data.arrayBuffer()),
      contentType: MIME_BY_EXT[extOf(paths[i])] ?? "application/octet-stream",
    });
  }
  return out;
}

// Active customer users of the load's customer. Inactive users are excluded.
async function customerRecipients(customerId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("email")
    .eq("role", "customer").eq("customer_id", customerId).eq("is_active", true);
  return ((data ?? []) as { email: string }[]).map((u) => u.email).filter(Boolean);
}

type CustomerLoad = {
  id: string; load_number: string; its_load_number: string | null; customer_id: string; status: string;
  equipment_size: number; moffett: boolean;
  pickup_timing: "appointment" | "window"; pickup_date: string; pickup_time_start: string; pickup_time_end: string | null;
  delivery_timing: "appointment" | "window"; delivery_date: string; delivery_time_start: string; delivery_time_end: string | null;
  pickup_contact_name: string; pickup_contact_phone: string; delivery_contact_name: string; delivery_contact_phone: string;
  pickup: Loc; delivery: Loc; carrier: { name: string } | null;
};

async function readLoadForCustomerMail(loadId: string): Promise<CustomerLoad | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("loads").select(
    "id,load_number,its_load_number,customer_id,status,equipment_size,moffett," +
    "pickup_timing,pickup_date,pickup_time_start,pickup_time_end,delivery_timing,delivery_date,delivery_time_start,delivery_time_end," +
    "pickup_contact_name,pickup_contact_phone,delivery_contact_name,delivery_contact_phone," +
    "pickup:locations!pickup_location_id(name,address_line,city,province,postal_code)," +
    "delivery:locations!delivery_location_id(name,address_line,city,province,postal_code)," +
    "carrier:carriers(name)",
  ).eq("id", loadId).maybeSingle();
  return (data as unknown as CustomerLoad | null) ?? null;
}

// Booking confirmation to every active customer user of the load's customer, ONE email, BOL attached.
// Call ONLY after the actor was verified as staff. Never throws. Returns the recipient count (0 = nothing sent).
export async function notifyCustomerBooked(loadId: string): Promise<number> {
  try {
    const l = await readLoadForCustomerMail(loadId);
    if (!l) return 0;
    const to = await customerRecipients(l.customer_id);
    if (to.length === 0) return 0;
    const num = itsOrRef(l);
    const link = `${siteUrl()}/loads/${l.id}`;

    const admin = createAdminClient();
    const { data: docs } = await admin.from("load_documents").select("storage_path")
      .eq("load_id", l.id).eq("kind", "bol").order("created_at");
    const paths = ((docs ?? []) as { storage_path: string }[]).map((d) => d.storage_path);

    let attachments: EmailAttachment[] = [];
    let bolLine: string;
    if (paths.length === 0) {
      bolLine = "The BOL will follow once uploaded.";
    } else {
      const files = await downloadBols(paths, num);
      const total = files ? files.reduce((n, f) => n + f.content.length, 0) : Infinity;
      if (!files || total > MAX_ATTACH_BYTES) {
        bolLine = `The BOL is available in the app: ${link}`;
      } else {
        attachments = files;
        bolLine = `The BOL is attached (${files.map((f) => f.filename).join(", ")}).`;
      }
    }

    const body = [
      `Load ${num} is booked.`,
      "",
      `Carrier: ${l.carrier?.name ?? "To be confirmed"}`,
      `Equipment: ${l.equipment_size} ft${l.moffett ? ", Moffett" : ""}`,
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
      bolLine,
      "",
      `Open the load: ${link}`,
    ].join("\n");
    const ok = await sendEmail(to, `Load ${num} booked`, body, attachments);
    return ok ? to.length : 0;
  } catch {
    return 0;
  }
}

// A BOL uploaded AFTER booking (status is no longer requested): send that file to the same customer users.
// Call ONLY after the actor was verified as staff. Never throws. Returns the recipient count (0 = nothing sent).
export async function notifyCustomerBolUploaded(loadId: string, storagePath: string): Promise<number> {
  try {
    const l = await readLoadForCustomerMail(loadId);
    if (!l || l.status === "requested" || l.status === "cancelled") return 0;
    const admin = createAdminClient();
    const { data: docs } = await admin.from("load_documents").select("storage_path")
      .eq("load_id", l.id).eq("kind", "bol").order("created_at");
    const all = ((docs ?? []) as { storage_path: string }[]).map((d) => d.storage_path);
    const index = all.indexOf(storagePath);
    if (index < 0) return 0; // only a BOL that really belongs to this load
    const to = await customerRecipients(l.customer_id);
    if (to.length === 0) return 0;
    const num = itsOrRef(l);
    const link = `${siteUrl()}/loads/${l.id}`;

    const { data: blob, error } = await admin.storage.from("documents").download(storagePath);
    let attachments: EmailAttachment[] = [];
    let line = `The BOL is available in the app: ${link}`;
    if (!error && blob) {
      const content = Buffer.from(await blob.arrayBuffer());
      if (content.length <= MAX_ATTACH_BYTES) {
        const filename = bolFilename(num, storagePath, index);
        attachments = [{ filename, content, contentType: MIME_BY_EXT[extOf(storagePath)] ?? "application/octet-stream" }];
        line = `The BOL is attached (${filename}).`;
      }
    }
    const body = [`A BOL was uploaded for load ${num}.`, "", line, "", `Open the load: ${link}`].join("\n");
    const ok = await sendEmail(to, `BOL for load ${num}`, body, attachments);
    return ok ? to.length : 0;
  } catch {
    return 0;
  }
}
