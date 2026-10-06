import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Shell } from "@/components/Shell";
import { Card, LinkButton, StatusChip, btnClass } from "@/components/ui";
import { CancelLoad } from "@/components/customer/CancelLoad";
import { requireCustomer } from "@/lib/auth";
import { LOAD_SELECT, type LoadWithRefs } from "@/lib/customer/queries";
import { fmtDateTime, fmtSlot, telHref } from "@/lib/format";
import { nameIsStreet } from "@/lib/address";
import { createClient } from "@/lib/supabase/server";
import { STATUS_LABEL, type Location, type LoadDocument, type LoadEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2 sm:grid sm:grid-cols-[180px_1fr] sm:gap-3">
      <dt className="text-[13px] font-medium text-muted">{label}</dt>
      <dd className="text-[16px] break-words">{children}</dd>
    </div>
  );
}

function Place({ loc, name, phone }: { loc: Location | null; name: string; phone: string }) {
  return (
    <>
      <p className="font-bold">{loc?.name ?? "Location unavailable"}</p>
      {loc ? (
        <p className="text-muted">
          {nameIsStreet(loc) ? "" : `${loc.address_line}, `}{loc.city}, {loc.province}{loc.postal_code ? ` ${loc.postal_code}` : ""}
        </p>
      ) : null}
      <p>
        {name},{" "}
        <a href={telHref(phone)} className="underline">{phone}</a>
      </p>
    </>
  );
}

export default async function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireCustomer();
  const supabase = await createClient();
  const { data } = await supabase.from("loads").select(LOAD_SELECT).eq("id", id).maybeSingle();
  if (!data) notFound();
  const l = data as unknown as LoadWithRefs;

  const [{ data: evData }, { data: docData }] = await Promise.all([
    supabase.from("load_events").select("*").eq("load_id", id).order("created_at", { ascending: true }).order("id", { ascending: true }),
    supabase.from("load_documents").select("*").eq("load_id", id).order("created_at", { ascending: true }),
  ]);
  const events = (evData ?? []) as LoadEvent[];
  const docs = (docData ?? []) as LoadDocument[];

  const signed = await Promise.all(
    docs.map(async (d) => {
      const { data: s } = await supabase.storage
        .from("documents")
        .createSignedUrl(d.storage_path, 300, d.kind === "bol" ? { download: true } : undefined);
      return { doc: d, url: s?.signedUrl ?? null };
    }),
  );
  const bols = signed.filter((s) => s.doc.kind === "bol");
  const pods = signed.filter((s) => s.doc.kind === "pod");

  const editable = l.status === "requested";
  // The "contact DLV" message applies only while dispatch owns the load (booked through at delivery).
  const frozen = ["booked", "at_pickup", "loading", "enroute", "at_delivery"].includes(l.status);

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <Link href="/loads" className="mb-3 inline-flex min-h-[44px] items-center text-[15px] underline">All loads</Link>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-bold">{l.load_number}</h1>
        <StatusChip status={l.status} />
      </div>

      {editable ? (
        <div className="mb-4 flex flex-wrap items-start gap-3">
          <LinkButton href={`/loads/${l.id}/edit`} variant="dark">Edit load</LinkButton>
          <CancelLoad loadId={l.id} loadNumber={l.load_number} />
        </div>
      ) : null}
      {frozen ? <p data-testid="load-state-note" className="mb-4 text-[15px] font-medium">Contact DLV to change this load</p> : null}
      {l.status === "delivered" ? (
        <p data-testid="load-state-note" className="mb-4 text-[15px] font-medium">
          Delivered{l.delivered_at ? ` on ${fmtDateTime(l.delivered_at)}` : ""}
        </p>
      ) : null}
      {l.status === "delivered" ? (
        <div className="mb-4">
          <LinkButton href={`/book?from=${l.id}`} variant="primary" big>Request again</LinkButton>
        </div>
      ) : null}
      {l.status === "cancelled" ? (
        <p data-testid="load-state-note" className="mb-4 text-[15px] font-medium">
          Cancelled{l.cancelled_at ? ` on ${fmtDateTime(l.cancelled_at)}` : ""}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-1 text-[20px] font-bold">Pickup</h2>
            <Place loc={l.pickup} name={l.pickup_contact_name} phone={l.pickup_contact_phone} />
            <p className="mt-1 font-medium">
              {fmtSlot(l.pickup_timing, l.pickup_date, l.pickup_time_start, l.pickup_time_end)}
            </p>
          </Card>
          <Card>
            <h2 className="mb-1 text-[20px] font-bold">Delivery</h2>
            <Place loc={l.delivery} name={l.delivery_contact_name} phone={l.delivery_contact_phone} />
            <p className="mt-1 font-medium">
              {fmtSlot(l.delivery_timing, l.delivery_date, l.delivery_time_start, l.delivery_time_end)}
            </p>
          </Card>
          <Card>
            <h2 className="mb-1 text-[20px] font-bold">Load details</h2>
            <dl className="divide-y divide-line">
              <Row label="Equipment">{l.equipment_size} ft{l.moffett ? ", Moffett" : ""}</Row>
              {l.weight_lbs != null ? <Row label="Weight">{Number(l.weight_lbs).toLocaleString("en-CA")} lbs</Row> : null}
              {l.pieces != null ? <Row label="Pieces">{l.pieces}</Row> : null}
              {l.po_number ? <Row label="PO number">{l.po_number}</Row> : null}
              {l.notes ? <Row label="Notes"><span className="whitespace-pre-wrap">{l.notes}</span></Row> : null}
              {l.carrier ? <Row label="Carrier">{l.carrier.name}</Row> : null}
              {l.eta ? <Row label="ETA">{fmtDateTime(l.eta)}</Row> : null}
              <Row label="Requested">{fmtDateTime(l.created_at)}</Row>
            </dl>
          </Card>
          <Card>
            <h2 className="mb-2 text-[20px] font-bold">Documents</h2>
            {bols.length === 0 && pods.length === 0 && l.status !== "delivered" ? (
              <p className="text-[15px] text-muted">No documents yet. The BOL appears here once DLV uploads it.</p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {bols.map((s, i) => s.url ? (
                  <a key={s.doc.id} href={s.url} className={btnClass("dark")}>
                    Download BOL{bols.length > 1 ? ` ${i + 1}` : ""}
                  </a>
                ) : (
                  <span key={s.doc.id} className="text-[15px] text-muted">BOL {i + 1} is unavailable right now.</span>
                ))}
                {pods.map((s, i) => s.url ? (
                  <a key={s.doc.id} href={s.url} target="_blank" rel="noopener noreferrer" className={btnClass("ghost")}>
                    View POD{pods.length > 1 ? ` ${i + 1}` : ""}
                  </a>
                ) : (
                  <span key={s.doc.id} className="text-[15px] text-muted">POD {i + 1} is unavailable right now.</span>
                ))}
              </div>
            )}
            {l.status === "delivered" && pods.length === 0 ? (
              <p data-testid="pod-missing" className="mt-3 text-[15px] font-medium">POD not uploaded yet.</p>
            ) : null}
          </Card>
        </div>

        <Card className="self-start">
          <h2 className="mb-3 text-[20px] font-bold">Timeline</h2>
          {events.length === 0 ? (
            <p className="text-[15px] text-muted">No events yet.</p>
          ) : (
            <ol className="space-y-4 border-l-2 border-line pl-4">
              {events.map((e) => (
                <li key={e.id} className="relative">
                  <span aria-hidden className="absolute -left-[23px] top-1.5 h-3 w-3 rounded-full bg-neon ring-2 ring-ink" />
                  <p className="text-[16px] font-bold">
                    {e.from_status === e.to_status ? `${STATUS_LABEL[e.to_status]}, update` : STATUS_LABEL[e.to_status]}
                  </p>
                  {e.from_status && e.from_status !== e.to_status ? (
                    <p className="text-[13px] text-muted">from {STATUS_LABEL[e.from_status]}</p>
                  ) : null}
                  {e.note ? <p className="text-[15px] break-words">{e.note}</p> : null}
                  <p className="text-[13px] text-muted">{fmtDateTime(e.created_at)}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </Shell>
  );
}
