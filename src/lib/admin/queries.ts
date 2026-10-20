import { fmtTime } from "@/lib/format";
import type { DocKind, LoadStatus } from "@/lib/types";

export type LocLite = { name: string; city: string; province: string };

export type BoardLoad = {
  id: string;
  load_number: string;
  po_number: string | null;
  created_at: string | null;
  its_load_number: string | null;
  status: LoadStatus;
  pickup_date: string;
  pickup_timing: "appointment" | "window";
  pickup_time_start: string;
  pickup_time_end: string | null;
  equipment_size: number;
  pickup_location_id: string;
  delivery_location_id: string;
  eta: string | null;
  carrier_id: string | null;
  return_of_load_id?: string | null; // R43: a return load (0019)
  delivered_at?: string | null;
  // R46: shown when a compact board card is expanded
  moffett?: boolean;
  notes?: string | null;
  pickup_contact_name?: string;
  pickup_contact_phone?: string;
  delivery_contact_name?: string;
  delivery_contact_phone?: string;
  pickup: LocLite | null;
  delivery: LocLite | null;
  carrier: { name: string } | null;
  load_documents: { kind: DocKind }[];
};

export const BOARD_SELECT =
  "id,load_number,po_number,created_at,its_load_number,status,pickup_date,pickup_timing,pickup_time_start,pickup_time_end,equipment_size,pickup_location_id,delivery_location_id,eta,carrier_id,return_of_load_id," +
  "delivered_at,moffett,notes,pickup_contact_name,pickup_contact_phone,delivery_contact_name,delivery_contact_phone," +
  "pickup:locations!pickup_location_id(name,city,province)," +
  "delivery:locations!delivery_location_id(name,city,province)," +
  "carrier:carriers(name),load_documents(kind)";

export const isReturn = (l: { return_of_load_id?: string | null }): boolean => Boolean(l.return_of_load_id);

export function routeOf(l: Pick<BoardLoad, "pickup" | "delivery">): string {
  return `${l.pickup?.name ?? "Unknown"} to ${l.delivery?.name ?? "Unknown"}`;
}

export function pickupTimeLabel(l: Pick<BoardLoad, "pickup_timing" | "pickup_time_start" | "pickup_time_end">): string {
  return l.pickup_timing === "window" && l.pickup_time_end
    ? `${fmtTime(l.pickup_time_start)} to ${fmtTime(l.pickup_time_end)} ET`
    : `${fmtTime(l.pickup_time_start)} ET`;
}

export { bolPending } from "@/lib/load-filters";

export function podPending(l: Pick<BoardLoad, "status" | "load_documents">): boolean {
  return l.status === "delivered" && !l.load_documents.some((d) => d.kind === "pod");
}
