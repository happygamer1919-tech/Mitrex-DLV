import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Card, LinkButton, Notice, StatusChip } from "@/components/ui";
import { ActionForm } from "@/components/admin/ActionForm";
import { AssignCarrierForm, BookLoadForm, EditItsForm, EtaForm, RemovePhotoButton, StaffUpload, StatusOverrideForm } from "@/components/admin/LoadControls";
import { ItsCopyCard } from "@/components/admin/ItsCopyCard";
import { laneLabel, resolve, type LaneReference } from "@/lib/admin/lane-reference";
import { DeleteLoadCard } from "@/components/admin/DeleteLoadCard";
import { LoadNumber } from "@/components/LoadNumber";
import { itsOrRef, staffLabel } from "@/lib/load-number";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime, fmtSlot, isoToEasternLocal, telHref } from "@/lib/format";
import { STATUS_LABEL, type DocKind, type LoadDocument, type LoadEvent, type LoadStatus } from "@/lib/types";

type Linked = { id: string; load_number: string; its_load_number: string | null; status: LoadStatus; carrier_id?: string | null; carrier?: { name: string } | null };
import { UUID } from "@/lib/admin/errors";
import { nameIsStreet } from "@/lib/address";
import { assignCarrier, cancelLoad } from "@/lib/admin/load-actions";
import { resendCarrierDetails } from "@/lib/admin/edit-actions";
import { canStaffEdit, canStaffReturn, offersCarrierEmail } from "@/lib/admin/staff-edit";
import { routeOf } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

const DOC_NAME: Record<DocKind, string> = { bol: "BOL", pod: "POD", pickup_photo: "Pickup photo", delivery_photo: "Delivery photo" };

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
      {nameIsStreet(l) ? "" : `${l.address_line}, `}{l.city}, {l.province} {l.postal_code ?? ""}
    </>
  );
}

// R44: the result line after a staff edit or a staff created return (?saved=...). Unknown values show nothing.
const SAVED: Record<string, string> = {
  "1": "Saved.",
  emailed: "Saved. The carrier was emailed.",
  mail_failed: "Saved. The carrier email could not be sent.",
  return: "Return created. It is a requested load for the same customer.",
};

export default async function AdminLoadPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string | string[] }>;
}) {
  const profile = await requireStaff();
  const { id } = await params;
  const { saved } = await searchParams;
  const savedMsg = typeof saved === "string" && Object.hasOwn(SAVED, saved) ? SAVED[saved] : null;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data } = await supabase.from("loads").select(SELECT).eq("id", id).maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const load = data as any;
  if (!load) notFound();

  const [carriersRes, eventsRes, docsRes, origRes, retRes] = await Promise.all([
    supabase.from("carriers").select("id,name,is_active").order("name"),
    supabase.from("load_events").select("*").eq("load_id", id).order("created_at").order("id"),
    supabase.from("load_documents").select("*").eq("load_id", id).order("created_at"),
    // R43: the link both ways, and the original's carrier for "Use the same carrier"
    load.return_of_load_id
      ? supabase.from("loads").select("id,load_number,its_load_number,status,carrier_id,carrier:carriers(name)").eq("id", load.return_of_load_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("loads").select("id,load_number,its_load_number,status").eq("return_of_load_id", id).order("created_at"),
  ]);
  const original = origRes.data as unknown as Linked | null;
  const returns = (retRes.data ?? []) as Linked[];
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

  // Staff only, evaluated live from the load's CURRENT pickup, delivery and size (no snapshot).
  const scenario = { pickupId: load.pickup_location_id as string, deliveryId: load.delivery_location_id as string, size: Number(load.equipment_size) };
  let reference: LaneReference | null = null;
  let referenceFailed = false;
  try {
    reference = await resolve(supabase, scenario.pickupId, scenario.deliveryId, scenario.size);
  } catch {
    referenceFailed = true;
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
  const hasPod = docs.some((d) => d.kind === "pod");

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <Link href="/admin" className="mb-2 inline-flex min-h-[44px] items-center text-[15px] underline">Back to board</Link>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-bold"><LoadNumber l={load} audience="staff" /></h1>
        <StatusChip status={status} />
        {!hasBol && ["booked", "at_pickup", "loading", "enroute", "at_delivery"].includes(status) ? (
          <span className="rounded-full bg-amber px-3 py-1 text-[13px] font-medium text-[#2B1500]">BOL pending</span>
        ) : null}
        {status === "delivered" && !hasPod ? (
          <span data-testid="pod-pending" className="rounded-full bg-amber px-3 py-1 text-[13px] font-medium text-[#2B1500]">POD pending</span>
        ) : null}
        {load.return_of_load_id ? (
          <span data-testid="return-badge" className="rounded-full bg-[#E4DCF5] px-3 py-1 text-[13px] font-bold text-[#3B2A78]">Return</span>
        ) : null}
      </div>
      {canStaffEdit(status) || canStaffReturn(status) ? (
        <div data-testid="staff-load-actions" className="mb-4 flex flex-wrap gap-2">
          {canStaffEdit(status) ? <LinkButton href={`/admin/loads/${load.id}/edit`} variant="dark">Edit details</LinkButton> : null}
          {canStaffReturn(status) ? <LinkButton href={`/admin/loads/${load.id}/return`} variant="ghost">Create return</LinkButton> : null}
        </div>
      ) : null}
      {savedMsg ? (
        <div data-testid="saved-notice" className="mb-4 max-w-2xl"><Notice tone="ok">{savedMsg}</Notice></div>
      ) : null}
      {original || returns.length > 0 ? (
        <div data-testid="return-links" className="mb-4 max-w-2xl rounded-[16px] border border-line bg-card p-4 text-[15px]">
          {original ? (
            <p data-testid="return-of">
              <Link href={`/admin/loads/${original.id}`} className="inline-flex min-h-[44px] items-center font-bold underline">Return of {staffLabel(original)}</Link>
            </p>
          ) : null}
          {returns.length > 0 ? (
            <div data-testid="return-loads">
              <p className="font-bold">Return loads:</p>
              <ul className="mt-1 space-y-1">
                {returns.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/loads/${r.id}`} className="inline-flex min-h-[44px] items-center underline">{staffLabel(r)}</Link>
                    <StatusChip status={r.status} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mb-4 max-w-2xl">
        <ItsCopyCard
          reference={reference}
          failed={referenceFailed}
          scenario={scenario}
          scenarioText={laneLabel(load.pickup?.name ?? "Unknown", load.delivery?.name ?? "Unknown", scenario.size)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-1 text-[20px] font-bold">Load details</h2>
            <dl className="divide-y divide-line">
              <Row label="ITS load number"><span data-testid="its-number">{load.its_load_number ?? "Not assigned yet"}</span></Row>
              <Row label="Request ref"><span data-testid="request-ref-row">{load.load_number}</span></Row>
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
              {original && !load.carrier_id ? (
                <div data-testid="original-carrier" className="mb-4 space-y-2 border-b border-line pb-4">
                  <p className="text-[15px]">Original carrier: <span className="font-bold">{original.carrier?.name ?? "Not assigned"}</span></p>
                  {original.carrier_id ? (
                    <ActionForm
                      action={assignCarrier}
                      fields={{ load_id: load.id, carrier_id: original.carrier_id }}
                      label="Use the same carrier"
                      pendingLabel="Saving..."
                      variant="dark"
                    />
                  ) : null}
                </div>
              ) : null}
              <AssignCarrierForm loadId={load.id} carrierId={load.carrier_id} carriers={carriers} />
              {offersCarrierEmail(load) ? (
                <div data-testid="resend-carrier" className="mt-4 border-t border-line pt-4">
                  <ActionForm
                    action={resendCarrierDetails}
                    fields={{ load_id: load.id }}
                    label="Email the details to the carrier again"
                    pendingLabel="Sending..."
                    variant="ghost"
                  />
                </div>
              ) : null}
              {status === "requested" ? (
                <div className="mt-4 border-t border-line pt-4">
                  <BookLoadForm loadId={load.id} carrierSaved={Boolean(load.carrier_id)} itsNumber={load.its_load_number} />
                </div>
              ) : null}
            </Card>
          ) : offersCarrierEmail(load) ? (
            // R44: a delivered load keeps no carrier controls, but staff can still send the carrier the details again.
            <Card>
              <h2 className="mb-3 text-[20px] font-bold">Carrier and booking</h2>
              <p className="text-[15px]">Carrier: <span className="font-bold">{load.carrier?.name ?? "Not assigned"}</span></p>
              <div data-testid="resend-carrier" className="mt-4 border-t border-line pt-4">
                <ActionForm
                  action={resendCarrierDetails}
                  fields={{ load_id: load.id }}
                  label="Email the details to the carrier again"
                  pendingLabel="Sending..."
                  variant="ghost"
                />
              </div>
            </Card>
          ) : null}

          {status !== "requested" ? (
            <Card>
              <h2 className="mb-3 text-[20px] font-bold">ITS load number</h2>
              <EditItsForm loadId={load.id} itsNumber={load.its_load_number} />
            </Card>
          ) : null}

          <Card>
            <h2 className="mb-3 text-[20px] font-bold">Documents</h2>
            {signed.length === 0 ? (
              <p className="mb-3 text-[15px] text-muted">No documents uploaded yet.</p>
            ) : (
              <ul className="mb-4 divide-y divide-line">
                {signed.map(({ d, url }) => (
                  <li key={d.id} data-testid="doc-row" data-kind={d.kind} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <p className="text-[15px] font-bold">{DOC_NAME[d.kind]}</p>
                      <p className="text-[13px] text-muted" data-testid="doc-time">{fmtDateTime(d.created_at)}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex min-h-[44px] items-center rounded-full border border-line px-5 text-[15px] font-bold">
                          {d.kind === "pickup_photo" || d.kind === "delivery_photo" ? "Open" : "Download"}
                        </a>
                      ) : <span className="text-[13px] text-muted">Link unavailable</span>}
                      {d.kind === "pickup_photo" || d.kind === "delivery_photo" ? (
                        <RemovePhotoButton loadId={load.id} docId={d.id} label={DOC_NAME[d.kind]} />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {status !== "cancelled" ? (
              <div className="space-y-6">
                <StaffUpload loadId={load.id} kind="bol" />
                <StaffUpload loadId={load.id} kind="pod" />
                <StaffUpload loadId={load.id} kind="pickup_photo" />
                <StaffUpload loadId={load.id} kind="delivery_photo" />
              </div>
            ) : null}
          </Card>

          {status === "enroute" || status === "at_delivery" ? (
            <Card>
              <h2 className="mb-3 text-[20px] font-bold">Update ETA</h2>
              <EtaForm loadId={load.id} etaLocal={load.eta ? isoToEasternLocal(load.eta) : ""} />
            </Card>
          ) : null}

          <Card>
            <h2 className="mb-1 text-[20px] font-bold">Override status</h2>
            <p className="mb-3 text-[13px] text-muted">Use for corrections. A note is required and goes in the timeline. Moving past a missing pickup or delivery photo is allowed for staff and is recorded in the timeline.</p>
            <StatusOverrideForm loadId={load.id} current={status} itsNumber={load.its_load_number} />
          </Card>

          {!closed ? (
            <Card>
              <h2 className="mb-3 text-[20px] font-bold">Cancel load</h2>
              <ActionForm
                action={cancelLoad}
                fields={{ load_id: load.id }}
                label="Cancel load"
                variant="danger"
                confirm={`Cancel ${staffLabel(load)}? The customer and carrier will see it as cancelled.`}
                confirmLabel="Yes, cancel load"
                pendingLabel="Cancelling..."
              />
            </Card>
          ) : null}
        </div>
      </div>

      {/* staff_admin only: not rendered at all for a csr (the action and the database function refuse them too) */}
      {profile.role === "staff_admin" ? (
        <div className="mt-6">
          <DeleteLoadCard
            loadId={load.id}
            confirmText={itsOrRef(load)}
            route={routeOf(load)}
            statusLabel={STATUS_LABEL[status]}
            documents={docs.length}
          />
        </div>
      ) : null}
    </Shell>
  );
}
