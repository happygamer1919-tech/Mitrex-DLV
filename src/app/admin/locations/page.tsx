import { Shell } from "@/components/Shell";
import { Notice, PageTitle } from "@/components/ui";
import { LocationManager, type LocationAuthors } from "@/components/admin/LocationManager";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminLocationsPage() {
  const profile = await requireStaff();
  const supabase = await createClient();
  const { data, error } = await supabase.from("locations").select("*").order("name");
  const locations = (data ?? []) as Location[];
  // R45: "Added by" and "Last edited by" name the profile (staff read every profile). A deleted author is simply not shown.
  const ids = [...new Set(locations.flatMap((l) => [l.created_by, l.updated_by]).filter((x): x is string => !!x))];
  const authors: LocationAuthors = {};
  if (ids.length > 0) {
    const { data: people } = await supabase.from("profiles").select("id,full_name,email").in("id", ids);
    for (const p of (people ?? []) as { id: string; full_name: string | null; email: string }[]) {
      authors[p.id] = p.full_name?.trim() || p.email;
    }
  }
  return (
    <Shell profile={profile}>
      <PageTitle>Locations</PageTitle>
      {error ? <div className="mb-4"><Notice tone="error">Could not load locations: {error.message}</Notice></div> : null}
      <LocationManager locations={locations} authors={authors} />
    </Shell>
  );
}
