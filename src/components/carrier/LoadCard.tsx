import Link from "next/link";
import { StatusChip } from "@/components/ui";
import { LoadNumber } from "@/components/LoadNumber";
import { MoffettBadge } from "@/components/carrier/MoffettBadge";
import { fmtDateTime, fmtSlot } from "@/lib/format";
import type { CarrierLoad } from "@/lib/carrier/loads";

function Stop({ label, name, city, province, slot }: { label: string; name: string; city: string; province: string; slot: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className="break-words text-[16px] font-bold">{name}</div>
      <div className="text-[15px]">{city}, {province}</div>
      <div className="text-[15px] text-muted">{slot}</div>
    </div>
  );
}

export function LoadCard({ load }: { load: CarrierLoad }) {
  const pu = load.pickup;
  const de = load.delivery;
  return (
    <Link
      href={`/my-loads/${load.id}`}
      className="block min-h-[48px] rounded-[16px] border border-line bg-card p-4 text-ink"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[20px] font-bold"><LoadNumber l={load} audience="carrier" /></span>
        <StatusChip status={load.status} />
        {load.moffett ? <MoffettBadge /> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Stop
          label="Pickup"
          name={pu?.name ?? "Location not available"}
          city={pu?.city ?? ""}
          province={pu?.province ?? ""}
          slot={fmtSlot(load.pickup_timing, load.pickup_date, load.pickup_time_start, load.pickup_time_end)}
        />
        <Stop
          label="Delivery"
          name={de?.name ?? "Location not available"}
          city={de?.city ?? ""}
          province={de?.province ?? ""}
          slot={fmtSlot(load.delivery_timing, load.delivery_date, load.delivery_time_start, load.delivery_time_end)}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[15px]">
        <span>{load.equipment_size} ft trailer</span>
        {load.eta && (load.status === "enroute" || load.status === "at_delivery") ? (
          <span className="font-bold">ETA {fmtDateTime(load.eta)}</span>
        ) : null}
        {load.status === "delivered" && load.delivered_at ? <span>Delivered {fmtDateTime(load.delivered_at)}</span> : null}
        {load.status === "cancelled" && load.cancelled_at ? <span>Cancelled {fmtDateTime(load.cancelled_at)}</span> : null}
      </div>
    </Link>
  );
}
