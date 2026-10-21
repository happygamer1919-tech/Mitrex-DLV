import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { customerLabel } from "@/lib/load-number";
import { PageTitle } from "@/components/ui";
import { LoadForm } from "@/components/customer/LoadForm";
import { requireCustomer } from "@/lib/auth";
import { loadToFormValues } from "@/lib/customer/queries";
import { todayEastern } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Load, Location } from "@/lib/types";
import type { ReturnContext } from "@/lib/customer/returnLoad";

export const dynamic = "force-dynamic";

export default async function EditLoadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireCustomer();
  const supabase = await createClient();
  const { data: load } = await supabase.from("loads").select("*").eq("id", id).maybeSingle();
  if (!load) notFound();
  const l = load as Load;
  if (l.status !== "requested") redirect(`/loads/${id}`);
  const { data: locs } = await supabase.from("locations").select("*").eq("is_active", true).order("name");
  const locations = (locs ?? []) as Location[];
  // R43: a return load keeps its fixed pickup and may still go back to the original shipper.
  let returnOf: ReturnContext | null = null;
  if (l.return_of_load_id) {
    const { data: o } = await supabase.from("loads").select("*").eq("id", l.return_of_load_id).maybeSingle();
    const orig = o as Load | null;
    const site = locations.find((x) => x.id === l.pickup_location_id);
    if (orig && site) {
      returnOf = {
        originalId: orig.id, originalLabel: customerLabel(orig), siteName: site.name, siteCity: site.city,
        originalPickupId: orig.pickup_location_id,
        originalPickupContact: { name: orig.pickup_contact_name, phone: orig.pickup_contact_phone },
        existingReturn: null,
      };
    }
  }
  return (
    <Shell profile={profile}>
      <PageTitle>Edit {customerLabel(l)}</PageTitle>
      <LoadForm mode="edit" loadId={id} locations={locations}
        initial={loadToFormValues(l)} today={todayEastern()} returnOf={returnOf} />
    </Shell>
  );
}
