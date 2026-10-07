"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteLoadCore } from "./delete-load";
import type { ActionState } from "./state";

// staff_admin only (requireAdmin first, and the database function checks the role again). Returns an error state,
// or redirects to /admin with the banner. The load is deleted through public.delete_load_forever with the admin's
// own session; the files are removed with the service role client, only the paths that function returned.
export async function deleteLoadForever(loadId: string, typed: string): Promise<ActionState> {
  await requireAdmin();
  const supabase = await createClient();
  const result = await deleteLoadCore(
    {
      rpcDelete: async (id, text) => {
        const r = await supabase.rpc("delete_load_forever", { p_load: id, p_confirm: text });
        return { data: r.data, error: r.error };
      },
      removeFiles: async (paths) => {
        const r = await createAdminClient().storage.from("documents").remove(paths);
        return { error: r.error };
      },
      recordOrphans: async (id, paths) => {
        const r = await supabase.rpc("record_load_deletion_orphans", { p_load: id, p_paths: paths });
        return { error: r.error };
      },
    },
    loadId,
    typed,
  );
  if (!result.ok) return { error: result.error };

  revalidatePath(`/admin/loads/${loadId}`);
  revalidatePath("/admin");
  revalidatePath("/admin/calendar");
  revalidatePath("/admin/export");
  revalidatePath("/loads");
  revalidatePath("/my-loads");
  const q = new URLSearchParams({ deleted: result.number });
  if (result.orphaned > 0) {
    q.set("orphans", String(result.orphaned));
    if (!result.orphansLogged) q.set("logged", "0");
  }
  redirect(`/admin?${q.toString()}`);
}
