import { fmtTime } from "@/lib/format";
import type { LoadStatus } from "@/lib/types";

export type LocLite = { name: string; city: string; province: string };

export type BoardLoad = {
  id: string;
  load_number: string;
  status: LoadStatus;
  pickup_date: string;
  pickup_timing: "appointment" | "window";
  pickup_time_start: string;
  pickup_time_end: string | null;
  equipment_size: number;
  eta: string | null;
  carrier_id: string | null;
  pickup: LocLite | null;
  delivery: LocLite | null;
  carrier: { name: string } | null;
  load_documents: { kind: "bol" | "pod" }[];
};

export const BOARD_SELECT =
  "id,load_number,status,pickup_date,pickup_timing,pickup_time_start,pickup_time_end,equipment_size,eta,carrier_id," +
  "pickup:locations!pickup_location_id(name,city,province)," +
  "delivery:locations!delivery_location_id(name,city,province)," +
  "carrier:carriers(name),load_documents(kind)";

export function routeOf(l: Pick<BoardLoad, "pickup" | "delivery">): string {
  return `${l.pickup?.name ?? "Unknown"} to ${l.delivery?.name ?? "Unknown"}`;
}

export function pickupTimeLabel(l: Pick<BoardLoad, "pickup_timing" | "pickup_time_start" | "pickup_time_end">): string {
  return l.pickup_timing === "window" && l.pickup_time_end
    ? `${fmtTime(l.pickup_time_start)} to ${fmtTime(l.pickup_time_end)} ET`
    : `${fmtTime(l.pickup_time_start)} ET`;
}

const BOL_EXPECTED: LoadStatus[] = ["booked", "at_pickup", "loading", "enroute", "at_delivery"];

export function bolPending(l: Pick<BoardLoad, "status" | "load_documents">): boolean {
  return BOL_EXPECTED.includes(l.status) && !l.load_documents.some((d) => d.kind === "bol");
}
