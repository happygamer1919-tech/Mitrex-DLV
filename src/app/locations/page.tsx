import { Shell } from "@/components/Shell";
import { Card, PageTitle } from "@/components/ui";
import { LocationRow } from "@/components/customer/LocationRow";
import { ChangeRequestForm, NewLocationForm } from "@/components/customer/LocationRequestForms";
import { requireCustomer } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Location, LocationRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

const REQ_TONE: Record<LocationRequest["status"], string> = {
  pending: "bg-[#FDE7CC] text-[#6B3A00]",
  approved: "bg-[#12875A] text-white",
  rejected: "bg-[#F7D9D9] text-[#7A1F1F]",
};

const FIELD_LABEL: Record<string, string> = {
  name: "name", address_line: "address", city: "city", province: "province", postal_code: "postal code",
};

export default async function LocationsPage() {
  const profile = await requireCustomer();
  const supabase = await createClient();
  const [{ data: locData }, { data: reqData }] = await Promise.all([
    supabase.from("locations").select("*").eq("is_active", true).order("name"),
    supabase.from("location_requests").select("*").eq("requested_by", profile.id).order("created_at", { ascending: false }),
  ]);
  const locations = (locData ?? []) as Location[];
  const requests = (reqData ?? []) as LocationRequest[];
  const nameOf = new Map(locations.map((l) => [l.id, l.name]));

  function describe(r: LocationRequest): string {
    const p = r.payload as Record<string, unknown>;
    if (r.kind === "new") return `New location: ${String(p.name ?? "")}`;
    const fields = Object.keys(FIELD_LABEL).filter((k) => typeof p[k] === "string" && p[k]).map((k) => FIELD_LABEL[k]);
    const target = r.location_id ? nameOf.get(r.location_id) ?? "location" : "location";
    return `Change for ${target}${fields.length ? ` (${fields.join(", ")})` : ""}`;
  }

  return (
    <Shell profile={profile}>
      <PageTitle>Locations</PageTitle>
      <section aria-label="Locations" className="space-y-3">
        {locations.length === 0 ? (
          <Card><p className="text-[15px] text-muted">No locations yet. Request a new location below.</p></Card>
        ) : (
          locations.map((l) => <LocationRow key={l.id} location={l} />)
        )}
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <NewLocationForm />
        <ChangeRequestForm locations={locations} />
      </div>

      <section aria-label="My requests" className="mt-6">
        <h2 className="mb-3 text-[20px] font-bold">My location requests</h2>
        {requests.length === 0 ? (
          <Card><p className="text-[15px] text-muted">You have not sent any location requests.</p></Card>
        ) : (
          <ul className="space-y-3">
            {requests.map((r) => (
              <li key={r.id}>
                <Card className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[16px] font-medium break-words">{describe(r)}</p>
                    <p className="text-[13px] text-muted">Sent {fmtDateTime(r.created_at)}</p>
                  </div>
                  <span className={`inline-flex rounded-full px-3 py-1 text-[13px] font-medium capitalize ${REQ_TONE[r.status]}`}>
                    {r.status}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
