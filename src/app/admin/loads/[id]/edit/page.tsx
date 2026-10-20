import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { PageTitle } from "@/components/ui";
import { LoadForm } from "@/components/customer/LoadForm";
import { getSessionProfile } from "@/lib/auth";
import { loadToFormValues } from "@/lib/customer/queries";
import { todayEastern } from "@/lib/format";
import { staffLabel } from "@/lib/load-number";
import { UUID } from "@/lib/admin/errors";
import { canStaffEdit, offersCarrierEmail, staffDeliveryOptions, staffPickupOptions } from "@/lib/admin/staff-edit";
import { createClient } from "@/lib/supabase/server";
import { isStaff, type Load, type Location } from "@/lib/types";

export const dynamic = "force-dynamic";

// R44: staff edit every detail of a load, at any status except cancelled. Signed out: the login page. Customers and
// carriers: not found (the staff actions refuse them too, and RLS refuses their update at the database).
export default async function StaffEditLoadPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (!isStaff(profile.role)) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data } = await supabase.from("loads").select("*").eq("id", id).maybeSingle();
  const load = data as Load | null;
  if (!load) notFound();
  if (!canStaffEdit(load.status)) redirect(`/admin/loads/${id}`);

  const [{ data: locs }, origRes] = await Promise.all([
    supabase.from("locations").select("*").order("name"),
    load.return_of_load_id
      ? supabase.from("loads").select("pickup_location_id,delivery_location_id").eq("id", load.return_of_load_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const locations = (locs ?? []) as Location[];
  const original = origRes.data as Pick<Load, "pickup_location_id" | "delivery_location_id"> | null;

  return (
    <Shell profile={profile}>
      <PageTitle>Edit {staffLabel(load)}</PageTitle>
      <p className="mb-4 max-w-2xl text-[15px] text-muted">
        Every change is written in the timeline that the customer and the carrier see. The carrier is emailed only if you tick the box below.
      </p>
      <LoadForm
        mode="edit"
        loadId={id}
        locations={locations}
        initial={loadToFormValues(load)}
        today={todayEastern()}
        staff={{
          pickupOptions: staffPickupOptions(locations, load.pickup_location_id, original?.delivery_location_id ?? null),
          deliveryOptions: staffDeliveryOptions(locations, load.delivery_location_id, original?.pickup_location_id ?? null),
          offerCarrierEmail: offersCarrierEmail(load),
        }}
      />
    </Shell>
  );
}
