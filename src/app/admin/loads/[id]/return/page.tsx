import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Notice, PageTitle } from "@/components/ui";
import { LoadForm } from "@/components/customer/LoadForm";
import { getSessionProfile } from "@/lib/auth";
import { returnValues, type ReturnContext } from "@/lib/customer/returnLoad";
import { todayEastern } from "@/lib/format";
import { staffLabel } from "@/lib/load-number";
import { UUID } from "@/lib/admin/errors";
import { canStaffReturn } from "@/lib/admin/staff-edit";
import { createClient } from "@/lib/supabase/server";
import { isStaff, type Load, type Location } from "@/lib/types";

export const dynamic = "force-dynamic";

// R44: staff create a return of a load at delivery or delivered, for the ORIGINAL load's customer. The form is the
// return form of R43 (pickup fixed to the original delivery site, the original shipper first) in staff mode.
export default async function StaffReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (!isStaff(profile.role)) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data } = await supabase.from("loads").select("*").eq("id", id).maybeSingle();
  const original = data as Load | null;
  if (!original) notFound();
  if (!canStaffReturn(original.status)) redirect(`/admin/loads/${id}`);

  const [{ data: locs }, { data: prev }] = await Promise.all([
    supabase.from("locations").select("*").eq("is_active", true).order("name"),
    supabase.from("loads").select("load_number,its_load_number")
      .eq("return_of_load_id", id).neq("status", "cancelled").order("created_at", { ascending: false }).limit(1),
  ]);
  const locations = (locs ?? []) as Location[];
  const site = locations.find((l) => l.id === original.delivery_location_id);
  const existing = ((prev ?? []) as { load_number: string; its_load_number: string | null }[])[0];

  if (!site) {
    return (
      <Shell profile={profile}>
        <PageTitle>Create a return</PageTitle>
        <Notice tone="error">
          The delivery location of {staffLabel(original)} is no longer active, so a return cannot pick up there. Activate it on the
          Locations page first.
        </Notice>
        <Link href={`/admin/loads/${id}`} className="mt-4 inline-flex min-h-[44px] items-center text-[15px] underline">Back to load</Link>
      </Shell>
    );
  }

  const returnOf: ReturnContext = {
    originalId: original.id,
    originalLabel: staffLabel(original),
    siteName: site.name,
    siteCity: site.city,
    originalPickupId: original.pickup_location_id,
    originalPickupContact: { name: original.pickup_contact_name, phone: original.pickup_contact_phone },
    existingReturn: existing ? staffLabel(existing) : null,
  };

  return (
    <Shell profile={profile}>
      <PageTitle>Create a return</PageTitle>
      <p className="mb-4 max-w-2xl text-[15px] text-muted">
        The return is a new requested load for the same customer, linked to {staffLabel(original)}. No request email is sent.
      </p>
      <LoadForm
        key={`staff-return-${original.id}`}
        mode="create"
        locations={locations}
        initial={returnValues(original)}
        today={todayEastern()}
        returnOf={returnOf}
        staff={{}}
      />
    </Shell>
  );
}
