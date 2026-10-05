import Link from "next/link";
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";

const CHIP: Record<LoadStatus, string> = {
  requested: "bg-[#DCE6F5] text-ink",
  booked: "bg-ink text-white",
  at_pickup: "bg-[#FDE7CC] text-[#6B3A00]",
  loading: "bg-[#FDE7CC] text-[#6B3A00]",
  enroute: "bg-amber text-[#2B1500]",
  at_delivery: "bg-[#E4DCF5] text-[#3B2A78]",
  delivered: "bg-[#12875A] text-white",
  cancelled: "bg-[#F7D9D9] text-[#7A1F1F]",
};

export function StatusChip({ status }: { status: LoadStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-[13px] font-medium ${CHIP[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[16px] border border-line bg-card p-4 ${className}`}>{children}</div>;
}

type Variant = "primary" | "dark" | "ghost" | "neon" | "white" | "danger";
const VARIANT: Record<Variant, string> = {
  primary: "bg-amber text-[#2B1500]",
  dark: "bg-ink text-white",
  ghost: "bg-transparent text-ink border border-line",
  neon: "bg-neon text-ink",
  white: "bg-white text-ink",
  danger: "bg-[#F7D9D9] text-[#7A1F1F]",
};

export function btnClass(variant: Variant = "primary", big = false) {
  return `inline-flex items-center justify-center rounded-full px-5 font-bold ${big ? "min-h-[56px] text-[18px]" : "min-h-[44px] text-[15px]"} ${VARIANT[variant]} disabled:opacity-50 cursor-pointer`;
}

export function Button({ variant = "primary", big = false, className = "", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; big?: boolean }) {
  return <button {...rest} className={`${btnClass(variant, big)} ${className}`} />;
}

export function LinkButton({ href, variant = "primary", big = false, children }:
  { href: string; variant?: Variant; big?: boolean; children: ReactNode }) {
  return <Link href={href} className={btnClass(variant, big)}>{children}</Link>;
}

const FIELD = "w-full min-h-[44px] rounded-[12px] border border-line bg-white px-3 text-[16px] text-ink";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[13px] text-muted">{hint}</span> : null}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${FIELD} ${p.className ?? ""}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${FIELD} ${p.className ?? ""}`} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`${FIELD} py-2 ${p.className ?? ""}`} />;

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-4 text-[24px] font-bold">{children}</h1>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "ok"; children: ReactNode }) {
  const t = { info: "bg-[#DCE6F5] text-ink", error: "bg-[#F7D9D9] text-[#7A1F1F]", ok: "bg-[#CFF5DE] text-ink" }[tone];
  return <div role={tone === "error" ? "alert" : "status"} className={`rounded-[12px] px-4 py-3 text-[15px] ${t}`}>{children}</div>;
}
