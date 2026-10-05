import { Shell } from "@/components/Shell";
import { Notice, PageTitle } from "@/components/ui";
import { LocationManager } from "@/components/admin/LocationManager";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminLocationsPage() {
  const profile = await requireStaff();
  const supabase = await createClient();
  const { data, error } = await supabase.from("locations").select("*").order("name");
  return (
    <Shell profile={profile}>
      <PageTitle>Locations</PageTitle>
      {error ? <div className="mb-4"><Notice tone="error">Could not load locations: {error.message}</Notice></div> : null}
      <LocationManager locations={(data ?? []) as Location[]} />
    </Shell>
  );
}
