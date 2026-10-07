import { RATE_STATUS_LABEL, type RateRequest } from "@/lib/rates/validate";

const CLASS: Record<RateRequest["status"], string> = {
  open: "bg-[#FDE7CC] text-[#6B3A00]",
  quoted: "bg-[#12875A] text-white",
  cancelled: "bg-[#F7D9D9] text-[#7A1F1F]",
};
const STAFF_LABEL: Record<RateRequest["status"], string> = { open: "Open", quoted: "Quoted", cancelled: "Cancelled" };

// Customer wording: Waiting for rate, Rate ready, Cancelled. Staff see Open, Quoted, Cancelled.
export function RateStatusBadge({ status, audience = "customer" }: { status: RateRequest["status"]; audience?: "customer" | "staff" }) {
  return (
    <span data-testid="rate-status" data-status={status} className={`inline-flex items-center rounded-full px-3 py-1 text-[13px] font-medium ${CLASS[status]}`}>
      {audience === "staff" ? STAFF_LABEL[status] : RATE_STATUS_LABEL[status]}
    </span>
  );
}
