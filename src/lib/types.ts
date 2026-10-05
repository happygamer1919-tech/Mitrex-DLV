export type Role = "staff_admin" | "staff_csr" | "customer" | "carrier_owner" | "carrier_driver";

export type LoadStatus =
  | "requested" | "booked" | "at_pickup" | "loading" | "enroute"
  | "at_delivery" | "delivered" | "cancelled";

export const STATUS_ORDER: LoadStatus[] = [
  "requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered",
];

export const STATUS_LABEL: Record<LoadStatus, string> = {
  requested: "Requested", booked: "Booked", at_pickup: "At pickup", loading: "Loading",
  enroute: "Enroute", at_delivery: "At delivery", delivered: "Delivered", cancelled: "Cancelled",
};

export type Profile = {
  id: string; email: string; full_name: string | null; role: Role;
  customer_id: string | null; carrier_id: string | null;
};

export type Location = {
  id: string; name: string; address_line: string; city: string; province: string;
  postal_code: string | null; can_ship: boolean; can_receive: boolean; requires_moffett: boolean;
  default_contact_name: string | null; default_contact_phone: string | null;
  is_active: boolean; needs_review: boolean; notes: string | null;
};

export type Carrier = { id: string; name: string; is_active: boolean };
export type Customer = { id: string; name: string };

export type Timing = "appointment" | "window";

export type Load = {
  id: string; load_number: string; customer_id: string; created_by: string;
  pickup_location_id: string; delivery_location_id: string;
  equipment_size: 26 | 36 | 48 | 53; moffett: boolean;
  weight_lbs: number | null; pieces: number | null; po_number: string | null; notes: string | null;
  pickup_timing: Timing; pickup_date: string; pickup_time_start: string; pickup_time_end: string | null;
  delivery_timing: Timing; delivery_date: string; delivery_time_start: string; delivery_time_end: string | null;
  pickup_contact_name: string; pickup_contact_phone: string;
  delivery_contact_name: string; delivery_contact_phone: string;
  status: LoadStatus; carrier_id: string | null; eta: string | null;
  booked_at: string | null; delivered_at: string | null; cancelled_at: string | null;
  created_at: string; updated_at: string;
};

export type LoadEvent = {
  id: number; load_id: string; from_status: LoadStatus | null; to_status: LoadStatus;
  actor_id: string | null; note: string | null; created_at: string;
};

export type LoadDocument = {
  id: string; load_id: string; kind: "bol" | "pod"; storage_path: string;
  uploaded_by: string; created_at: string;
};

export type LocationRequest = {
  id: string; kind: "new" | "change"; location_id: string | null;
  payload: Record<string, unknown>; requested_by: string;
  status: "pending" | "approved" | "rejected"; created_at: string;
};

export const isStaff = (r: Role) => r === "staff_admin" || r === "staff_csr";
export const isCarrier = (r: Role) => r === "carrier_owner" || r === "carrier_driver";
