import { Shell } from "@/components/Shell";
import { Notice, PageTitle } from "@/components/ui";
import { NameManager } from "@/components/admin/NameManager";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createCarrier, renameCarrier, setCarrierActive } from "@/lib/admin/org-actions";

export const dynamic = "force-dynamic";

export default async function CarriersPage() {
  const profile = await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.from("carriers").select("id,name,is_active").order("name");
  return (
    <Shell profile={profile}>
      <PageTitle>Carriers</PageTitle>
      {error ? <div className="mb-4"><Notice tone="error">Could not load carriers: {error.message}</Notice></div> : null}
      <NameManager
        noun="carrier"
        items={(data ?? []) as { id: string; name: string; is_active: boolean }[]}
        createAction={createCarrier}
        renameAction={renameCarrier}
        toggleAction={setCarrierActive}
      />
    </Shell>
  );
}
