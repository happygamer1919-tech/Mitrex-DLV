import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Card, StatusChip } from "@/components/ui";
import { ActionForm } from "@/components/admin/ActionForm";
import { AssignCarrierForm, BolUpload, EtaForm, StatusOverrideForm } from "@/components/admin/LoadControls";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime, fmtSlot, isoToEasternLocal, telHref } from "@/lib/format";
import { STATUS_LABEL, type LoadDocument, type LoadEvent } from "@/lib/types";
import { UUID } from "@/lib/admin/errors";
import { cancelLoad, markBooked } from "@/lib/admin/load-actions";

export const dynamic = "force-dynamic";

type Loc = {
  name: string; address_line: string; city: string; province: string; postal_code: string | null;
  default_contact_name: string | null;
};

const SELECT =
  "*,pickup:locations!pickup_location_id(name,address_line,city,province,postal_code)," +
  "delivery:locations!delivery_location_id(name,address_line,city,province,postal_code)," +
  "customer:customers(name),carrier:carriers(name)";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2 sm:grid sm:grid-cols-[160px_1fr] sm:gap-3">
      <dt className="text-[13px] font-medium text-muted">{label}</dt>
      <dd className="break-words text-[15px]">{children}</dd>
    </div>
  );
}

function Address({ l }: { l: Loc | null }) {
  if (!l) return <>Unknown</>;
  return (
    <>
      <span className="font-bold">{l.name}</span><br />
      {l.address_line}, {l.city}, {l.province} {l.postal_code ?? ""}
    </>
  );
}

export default async function AdminLoadPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await requireStaff();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data } = await supabase.from("loads").select(SELECT).eq("id", id).maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const load = data as any;
  if (!load) notFound();

  const [carriersRes, eventsRes, docsRes] = await Promise.all([
    supabase.from("carriers").select("id,name,is_active").order("name"),
    supabase.from("load_events").select("*").eq("load_id", id).order("created_at").order("id"),
    supabase.from("load_documents").select("*").eq("load_id", id).order("created_at"),
  ]);
  const carriers = (carriersRes.data ?? []) as { id: string; name: string; is_active: boolean }[];
  const events = (eventsRes.data ?? []) as LoadEvent[];
  const docs = (docsRes.data ?? []) as LoadDocument[];

  const actorIds = [...new Set(events.map((e) => e.actor_id).filter((v): v is string => !!v))];
  const actors = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: ps } = await supabase.from("profiles").select("id,email,full_name").in("id", actorIds);
    ((ps ?? []) as { id: string; email: string; full_name: string | null }[])
      .forEach((p) => actors.set(p.id, p.full_name || p.email));
  }

  const signed = await Promise.all(
    docs.map(async (d) => {
      const { data: s } = await supabase.storage.from("documents").createSignedUrl(d.storage_path, 300);
      return { d, url: s?.signedUrl ?? null };
    }),
  );

  const status = load.status as keyof typeof STATUS_LABEL;
  const closed = status === "delivered" || status === "cancelled";
  const hasBol = docs.some((d) => d.kind === "bol");

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <Link href="/admin" className="mb-2 inline-flex min-h-[44px] items-center text-[15px] underline">Back to board</Link>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-bold">{load.load_number}</h1>
        <StatusChip status={status} />
        {!hasBol && ["booked", "at_pickup", "loading", "enroute", "at_delivery"].includes(status) ? (
          <span className="rounded-full bg-amber px-3 py-1 text-[13px] font-medium text-[#2B1500]">BOL pending</span>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-1 text-[20px] font-bold">Load details</h2>
            <dl className="divide-y divide-line">
              <Row label="Customer">{load.customer?.name ?? "Unknown"}</Row>
              <Row label="Pickup"><Address l={load.pickup} /></Row>
              <Row label="Pickup time">{fmtSlot(load.pickup_timing, load.pickup_date, load.pickup_time_start, load.pickup_time_end)}</Row>
              <Row label="Delivery"><Address l={load.delivery} /></Row>
              <Row label="Delivery time">{fmtSlot(load.delivery_timing, load.delivery_date, load.delivery_time_start, load.delivery_time_end)}</Row>
              <Row label="Equipment">{load.equipment_size} ft{load.moffett ? ", Moffett" : ""}</Row>
              <Row label="Weight">{load.weight_lbs != null ? `${Number(load.weight_lbs).toLocaleString("en-CA")} lbs` : "Not given"}</Row>
              <Row label="Pieces">{load.pieces ?? "Not given"}</Row>
              <Row label="PO number">{load.po_number || "None"}</Row>
              <Row label="Notes">{load.notes || "None"}</Row>
              <Row label="Carrier">{load.carrier?.name ?? "Not assigned"}</Row>
              <Row label="ETA">{load.eta ? fmtDateTime(load.eta) : "Not set"}</Row>
              <Row label="Requested">{fmtDateTime(load.created_at)}</Row>
              {load.booked_at ? <Row label="Booked">{fmtDateTime(load.booked_at)}</Row> : null}
              {load.delivered_at ? <Row label="Delivered">{fmtDateTime(load.delivered_at)}</Row> : null}
              {load.cancelled_at ? <Row label="Cancelled">{fmtDateTime(load.cancelled_at)}</Row> : null}
            </dl>
          </Card>

          <Card>
            <h2 className="mb-1 text-[20px] font-bold">Contacts</h2>
            <dl className="divide-y divide-line">
              <Row label="Pickup contact">
                {load.pickup_contact_name}, <a className="underline" href={telHref(load.pickup_contact_phone)}>{load.pickup_contact_phone}</a>
              </Row>
              <Row label="Delivery contact">
                {load.delivery_contact_name}, <a className="underline" href={telHref(load.delivery_contact_phone)}>{load.delivery_contact_phone}</a>
              </Row>
            </dl>
          </Card>

          <Card>
            <h2 className="mb-3 text-[20px] font-bold">Timeline</h2>
            {events.length === 0 ? (
              <p className="text-[15px] text-muted">No events yet.</p>
            ) : (
              <ol className="space-y-3">
                {events.map((e) => (
                  <li key={e.id} className="border-l-4 border-neon pl-3">
                    <p className="text-[15px] font-medium">
                      {e.from_status && e.from_status !== e.to_status
                        ? `${STATUS_LABEL[e.from_status]} to ${STATUS_LABEL[e.to_status]}`
                        : e.from_status ? `${STATUS_LABEL[e.to_status]} (update)` : STATUS_LABEL[e.to_status]}
                    </p>
                    {e.note ? <p className="break-words text-[15px]">{e.note}</p> : null}
                    <p className="text-[13px] text-muted">
                      {fmtDateTime(e.created_at)}{e.actor_id ? `, ${actors.get(e.actor_id) ?? "Unknown user"}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          {!closed ? (
            <Card>
              <h2 className="mb-3 text-[20px] font-bold">Carrier and booking</h2>
              <AssignCarrierForm loadId={load.id} carrierId={load.carrier_id} carriers={carriers} />
              {status === "requested" ? (
                <div className="mt-4 border-t border-line pt-4">
                  <p className="mb-2 text-[13px] text-muted">Booking emails every user of the assigned carrier.</p>
                  <ActionForm
                    action={markBooked}
                    fields={{ load_id: load.id }}
                    label="Mark booked"
                    pendingLabel="Booking..."
                    variant="primary"
                  />
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card>
            <h2 className="mb-3 text-[20px] font-bold">Documents</h2>
            {signed.length === 0 ? (
              <p className="mb-3 text-[15px] text-muted">No documents uploaded yet.</p>
            ) : (
              <ul className="mb-4 divide-y divide-line">
                {signed.map(({ d, url }) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <p className="text-[15px] font-bold">{d.kind === "bol" ? "BOL" : "POD"}</p>
                      <p className="text-[13px] text-muted">{fmtDateTime(d.created_at)}</p>
                    </div>
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex min-h-[44px] items-center rounded-full border border-line px-5 text-[15px] font-bold">
                        Download
                      </a>
                    ) : <span className="text-[13px] text-muted">Link unavailable</span>}
                  </li>
                ))}
              </ul>
            )}
            {status !== "cancelled" ? <BolUpload loadId={load.id} /> : null}
          </Card>

          {status === "enroute" || status === "at_delivery" ? (
            <Card>
              <h2 className="mb-3 text-[20px] font-bold">Update ETA</h2>
              <EtaForm loadId={load.id} etaLocal={load.eta ? isoToEasternLocal(load.eta) : ""} />
            </Card>
          ) : null}

          <Card>
            <h2 className="mb-1 text-[20px] font-bold">Override status</h2>
            <p className="mb-3 text-[13px] text-muted">Use for corrections. A note is required and goes in the timeline.</p>
            <StatusOverrideForm loadId={load.id} current={status} />
          </Card>

          {!closed ? (
            <Card>
              <h2 className="mb-3 text-[20px] font-bold">Cancel load</h2>
              <ActionForm
                action={cancelLoad}
                fields={{ load_id: load.id }}
                label="Cancel load"
                variant="danger"
                confirm={`Cancel ${load.load_number}? The customer and carrier will see it as cancelled.`}
                confirmLabel="Yes, cancel load"
                pendingLabel="Cancelling..."
              />
            </Card>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
