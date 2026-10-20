import { Shell } from "@/components/Shell";
import { Card, PageTitle } from "@/components/ui";
import { AddLocationForm, LocationCard } from "@/components/customer/CustomerLocations";
import { requireCustomer } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Location, LocationRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

const FIELD_LABEL: Record<string, string> = {
  name: "name", address_line: "address", city: "city", province: "province", postal_code: "postal code",
};

// R23 and R45 (DLV-041): Maria adds and edits her locations herself. The old request flows are gone from this page;
// requests she sent earlier that DLV has not answered yet are listed read only.
export default async function LocationsPage() {
  const profile = await requireCustomer();
  const supabase = await createClient();
  const [{ data: locData }, { data: reqData }] = await Promise.all([
    supabase.from("locations").select("*").eq("is_active", true).order("name"),
    supabase.from("location_requests").select("*").eq("requested_by", profile.id).eq("status", "pending")
      .order("created_at", { ascending: false }),
  ]);
  const locations = (locData ?? []) as Location[];
  const pending = (reqData ?? []) as LocationRequest[];
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
      <p className="mb-4 text-[15px] text-muted">
        Add a location or change one whenever you need to. Changes are saved at once and the booking form uses them
        straight away. <a href="#add-location" className="inline-flex min-h-[44px] items-center font-bold text-ink underline">Add location</a>
      </p>

      {pending.length > 0 ? (
        <section aria-label="Requests waiting for DLV" className="mb-6">
          <h2 className="mb-3 text-[20px] font-bold">Requests waiting for DLV</h2>
          <p className="mb-3 text-[13px] text-muted">You sent these before you could change locations yourself. DLV will still answer them.</p>
          <ul className="space-y-3">
            {pending.map((r) => (
              <li key={r.id}>
                <Card className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[16px] font-medium break-words">{describe(r)}</p>
                    <p className="text-[13px] text-muted">Sent {fmtDateTime(r.created_at)}</p>
                  </div>
                  <span className="inline-flex rounded-full bg-[#FDE7CC] px-3 py-1 text-[13px] font-medium text-[#6B3A00]">Waiting for DLV</span>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Locations" className="space-y-3">
        {locations.length === 0 ? (
          <Card><p className="text-[15px] text-muted">No locations yet. Add the first one below.</p></Card>
        ) : (
          locations.map((l) => <LocationCard key={l.id} location={l} />)
        )}
      </section>

      <section aria-label="Add location" className="mt-6">
        <AddLocationForm />
      </section>
    </Shell>
  );
}
