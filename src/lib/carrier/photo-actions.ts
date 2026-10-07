"use server";

import { revalidatePath } from "next/cache";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/carrier/loads";

export type PhotoActionResult = { ok: true } | { ok: false; error: string; code?: "auth" };

// Removes one load photo. The database function public.delete_load_photo decides who may (a carrier its own photo
// while the step is open, staff any photo, nobody else) and returns the storage path; the file is then removed
// with the service role client, only the path that function returned for this load.
export async function removeLoadPhoto(loadId: string, docId: string): Promise<PhotoActionResult> {
  if (!UUID_RE.test(loadId) || !UUID_RE.test(docId)) return { ok: false, error: "That photo could not be found." };
  const profile = await getSessionProfile();
  if (!profile) return { ok: false, error: "Your session has expired. Sending you to sign in.", code: "auth" };
  if (profile.role === "customer") return { ok: false, error: "You are not allowed to do that." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delete_load_photo", { p_doc: docId });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "This photo can no longer be removed." };
    if (error.code === "P0002") return { ok: false, error: "That photo is already gone. Refreshing now." };
    return { ok: false, error: "The photo could not be removed. Try again." };
  }
  const path = typeof data === "string" ? data : "";
  if (path.startsWith(`${loadId}/`)) {
    // The row is gone. A file that cannot be removed now is unreachable from the app and is a cleanup item only.
    try { await createAdminClient().storage.from("documents").remove([path]); } catch { /* logged by storage */ }
  }
  revalidatePath("/my-loads");
  revalidatePath(`/my-loads/${loadId}`);
  revalidatePath(`/admin/loads/${loadId}`);
  revalidatePath(`/loads/${loadId}`);
  return { ok: true };
}
