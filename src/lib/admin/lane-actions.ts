"use server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID, plainError, str } from "./errors";
import type { ActionState } from "./state";
import { LANE_SIZES, NOTE_MAX, validLaneNumber } from "./lane-reference";
import { MAX_IMPORT_ROWS, validateLaneImport } from "./lane-csv";

// Staff only (admin and csr alike). RLS refuses anyone else again at the database.
const DUPLICATE = "A lane reference for this pickup, delivery and truck size already exists. Edit that row instead.";

function done() {
  revalidatePath("/admin/lanes");
  revalidatePath("/admin");
  revalidatePath("/admin/loads/[id]", "page");
}

function sizeOf(fd: FormData): number | null {
  const n = Number(str(fd, "size"));
  return (LANE_SIZES as readonly number[]).includes(n) ? n : null;
}

export async function createLane(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const pickup = str(fd, "pickup");
  const delivery = str(fd, "delivery");
  const size = sizeOf(fd);
  const number = str(fd, "number");
  const note = str(fd, "note");
  if (!UUID.test(pickup)) return { error: "Choose the pickup location." };
  if (!UUID.test(delivery)) return { error: "Choose the delivery location." };
  if (pickup === delivery) return { error: "Pickup and delivery must be different locations." };
  if (size === null) return { error: "Truck size must be 26, 36 or 53." };
  const bad = validLaneNumber(number);
  if (bad) return { error: bad };
  if (note.length > NOTE_MAX) return { error: `The note is too long (at most ${NOTE_MAX} characters).` };
  const sb = await createClient();
  const { error } = await sb.from("lane_references").insert({
    pickup_location_id: pickup, delivery_location_id: delivery, equipment_size: size, its_reference_load: number, note: note || null,
  });
  if (error) return { error: error.code === "23505" ? DUPLICATE : plainError(error) };
  done();
  return { ok: "Lane added." };
}

export async function updateLane(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "id");
  const number = str(fd, "number");
  const note = str(fd, "note");
  if (!UUID.test(id)) return { error: "Lane not found." };
  const bad = validLaneNumber(number);
  if (bad) return { error: bad };
  if (note.length > NOTE_MAX) return { error: `The note is too long (at most ${NOTE_MAX} characters).` };
  const sb = await createClient();
  const { data, error } = await sb.from("lane_references")
    .update({ its_reference_load: number, note: note || null }).eq("id", id).select("id");
  if (error) return { error: plainError(error) };
  if (!data || data.length === 0) return { error: "Lane not found." };
  done();
  return { ok: "Saved." };
}

export async function deleteLane(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "Lane not found." };
  const sb = await createClient();
  const { data, error } = await sb.from("lane_references").delete().eq("id", id).select("id");
  if (error) return { error: plainError(error) };
  if (!data || data.length === 0) return { error: "Lane not found." };
  done();
  return { ok: "Deleted." };
}

// All or nothing: the text is validated again here (the browser preview is only a convenience), and the whole file
// goes in as ONE upsert statement on the scenario key.
export async function importLanes(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const text = typeof fd.get("text") === "string" ? (fd.get("text") as string) : "";
  const sb = await createClient();
  const { data: locs, error: le } = await sb.from("locations").select("id,name");
  if (le) return { error: plainError(le) };
  const preview = validateLaneImport(text, (locs ?? []) as { id: string; name: string }[]);
  if (!preview.valid) {
    const bad = preview.rows.filter((r) => r.errors.length > 0).length;
    return { error: preview.fileErrors[0] ?? `Nothing was imported. ${bad} row${bad === 1 ? " has" : "s have"} errors (the file allows at most ${MAX_IMPORT_ROWS} rows).` };
  }
  const rows = preview.rows.map((r) => ({
    pickup_location_id: r.pickupId!, delivery_location_id: r.deliveryId!, equipment_size: r.sizeNum!,
    its_reference_load: r.number, note: r.note || null,
  }));
  const { data: existing, error: ee } = await sb.from("lane_references").select("pickup_location_id,delivery_location_id,equipment_size").limit(5000);
  if (ee) return { error: plainError(ee) };
  const had = new Set((existing ?? []).map((e) => `${e.pickup_location_id}|${e.delivery_location_id}|${e.equipment_size}`));
  const updated = rows.filter((r) => had.has(`${r.pickup_location_id}|${r.delivery_location_id}|${r.equipment_size}`)).length;
  const { error } = await sb.from("lane_references").upsert(rows, { onConflict: "pickup_location_id,delivery_location_id,equipment_size" });
  if (error) return { error: `Nothing was imported. ${plainError(error)}` };
  done();
  return { ok: `Imported ${rows.length} lane${rows.length === 1 ? "" : "s"} (${rows.length - updated} new, ${updated} updated).` };
}
