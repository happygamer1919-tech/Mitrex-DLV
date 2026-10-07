import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { LiveRefresh } from "@/components/LiveRefresh";
import { LoadNumber } from "@/components/LoadNumber";
import { btnClass, Card, Notice, StatusChip } from "@/components/ui";
import { MoffettBadge } from "@/components/carrier/MoffettBadge";
import { Progress } from "@/components/carrier/Progress";
import { StopCard } from "@/components/carrier/StopCard";
import { LoadActions } from "@/components/carrier/LoadActions";
import { PodCard } from "@/components/carrier/PodCard";
import { requireCarrier } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime, isoToEasternLocal } from "@/lib/format";
import { deliveryStartLocal, LOAD_SELECT, UUID_RE, type CarrierLoad } from "@/lib/carrier/loads";
import type { LoadDocument } from "@/lib/types";
import { photoKindForStatus, type PhotoItem } from "@/lib/carrier/photos";

export const dynamic = "force-dynamic";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] font-medium text-muted">{label}</dt>
      <dd className="break-words text-[16px] font-bold">{value}</dd>
    </div>
  );
}

export default async function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireCarrier();
  if (!UUID_RE.test(id)) notFound();

  const supabase = await createClient();
  const { data } = await supabase.from("loads").select(LOAD_SELECT).eq("id", id).maybeSingle();
  if (!data) notFound();
  const load = data as unknown as CarrierLoad;

  const { data: docRows } = await supabase
    .from("load_documents")
    .select("id,load_id,kind,storage_path,uploaded_by,created_at")
    .eq("load_id", id)
    .order("created_at", { ascending: false });
  const docs = (docRows ?? []) as LoadDocument[];
  const bol = docs.find((d) => d.kind === "bol");
  const podDocs = docs.filter((d) => d.kind === "pod");
  const pod = podDocs[0];

  async function signed(path: string | undefined): Promise<string | null> {
    if (!path) return null;
    const { data: s } = await supabase.storage.from("documents").createSignedUrl(path, 300);
    return s?.signedUrl ?? null;
  }
  const bolUrl = await signed(bol?.storage_path);
  const pods = await Promise.all(podDocs.map(async (d) => ({ id: d.id, url: await signed(d.storage_path) })));

  // The photos of the step this status asks for (loaded photo while loading, delivery photo at delivery), oldest first.
  // `created_at` is the server time of the insert and is the official time shown to everyone.
  const stepKind = photoKindForStatus(load.status);
  const stepPhotos: PhotoItem[] = stepKind
    ? await Promise.all(
        docs.filter((d) => d.kind === stepKind).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(async (d) => ({
          id: d.id, url: await signed(d.storage_path), when: fmtDateTime(d.created_at), mine: d.uploaded_by === profile.id,
        })),
      )
    : [];

  const finished = load.status === "delivered" || load.status === "cancelled";

  return (
    <Shell profile={profile} driver>
      <LiveRefresh />
      <div className="mx-auto max-w-3xl space-y-4">
        <Link href="/my-loads" className="inline-flex min-h-[48px] items-center text-[15px] font-medium text-white underline">
          Back to my loads
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[24px] font-bold"><LoadNumber l={load} audience="carrier" /></h1>
          <StatusChip status={load.status} />
          {load.moffett ? <MoffettBadge /> : null}
        </div>

        {load.status === "cancelled" ? (
          <Notice tone="error">This load was cancelled{load.cancelled_at ? ` on ${fmtDateTime(load.cancelled_at)}` : ""}. No further action is needed.</Notice>
        ) : (
          <Progress status={load.status} />
        )}

        {load.status === "delivered" ? (
          <Notice tone="ok">Delivered{load.delivered_at ? ` on ${fmtDateTime(load.delivered_at)}` : ""}. This load is complete.</Notice>
        ) : null}

        {!finished ? (
          <LoadActions
            loadId={load.id}
            userId={profile.id}
            status={load.status}
            etaLabel={load.eta ? fmtDateTime(load.eta) : null}
            etaLocal={load.eta ? isoToEasternLocal(load.eta) : null}
            defaultEtaLocal={deliveryStartLocal(load)}
            hasPod={Boolean(pod)}
            photos={stepPhotos}
          />
        ) : load.eta ? (
          <p className="text-[15px] text-white/80">Last ETA: {fmtDateTime(load.eta)}</p>
        ) : null}

        {load.status === "delivered" ? <PodCard loadId={load.id} userId={profile.id} pods={pods} /> : null}

        <div className="grid gap-4 md:grid-cols-2">
          <StopCard
            title="Pickup"
            location={load.pickup}
            timing={load.pickup_timing}
            date={load.pickup_date}
            start={load.pickup_time_start}
            end={load.pickup_time_end}
            contactName={load.pickup_contact_name}
            contactPhone={load.pickup_contact_phone}
          />
          <StopCard
            title="Delivery"
            location={load.delivery}
            timing={load.delivery_timing}
            date={load.delivery_date}
            start={load.delivery_time_start}
            end={load.delivery_time_end}
            contactName={load.delivery_contact_name}
            contactPhone={load.delivery_contact_phone}
          />
        </div>

        <Card className="space-y-4 text-ink">
          <h2 className="text-[20px] font-bold">Freight</h2>
          <dl className="grid grid-cols-2 gap-4">
            <Fact label="Equipment" value={`${load.equipment_size} ft trailer`} />
            <Fact label="Moffett" value={load.moffett ? "Required" : "Not required"} />
            <Fact label="Weight" value={load.weight_lbs != null ? `${Number(load.weight_lbs).toLocaleString("en-CA")} lbs` : "Not given"} />
            <Fact label="Pieces" value={load.pieces != null ? String(load.pieces) : "Not given"} />
            <Fact label="PO number" value={load.po_number || "None"} />
          </dl>
          {load.notes ? (
            <div>
              <div className="text-[13px] font-medium text-muted">Notes</div>
              <div className="whitespace-pre-line break-words text-[16px]">{load.notes}</div>
            </div>
          ) : null}
        </Card>

        <Card className="space-y-3 text-ink">
          <h2 className="text-[20px] font-bold">Documents</h2>
          {bolUrl ? (
            <a href={bolUrl} target="_blank" rel="noopener noreferrer" className={`${btnClass("dark", true)} min-h-[56px] w-full`}>
              Download BOL
            </a>
          ) : (
            <p className="text-[15px] text-muted">{bol ? "The BOL link could not be created. Refresh the page." : "No BOL has been uploaded yet."}</p>
          )}
        </Card>
      </div>
    </Shell>
  );
}
