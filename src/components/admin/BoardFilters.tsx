import Link from "next/link";
import { STATUS_LABEL } from "@/lib/types";
import {
  SIZES, SORT_KEYS, STATUSES, toQuery, type BoardFilters as F, type SortKey,
} from "@/lib/admin/board-filters";

type Opt = { id: string; name: string };

export const SORT_LABEL: Record<SortKey, string> = {
  pickup_time: "Pickup time", shipper: "Shipper", receiver: "Receiver", carrier: "Carrier",
  its_number: "ITS number", size: "Size", created: "Created",
};

const WHEN_LABEL = { today: "Today", tomorrow: "Tomorrow", week: "Next 7 days", custom: "Custom dates" } as const;
const field = "min-h-[44px] w-full rounded-[12px] border border-line bg-white px-3 text-[15px]";

function Pill({ href, active, children, testid }: { href: string; active: boolean; children: React.ReactNode; testid: string }) {
  return (
    <Link href={href} data-testid={testid} aria-pressed={active}
      className={`inline-flex min-h-[44px] items-center rounded-full border px-4 text-[14px] font-medium ${active ? "border-ink bg-mint" : "border-line bg-white"}`}>
      {children}
    </Link>
  );
}

// Staff board controls. A plain GET form: the state lives in the URL, so it works without JavaScript,
// can be bookmarked and survives the 15 second live refresh.
export function BoardFilters({ f, carriers, shippers, receivers }: { f: F; carriers: Opt[]; shippers: Opt[]; receivers: Opt[] }) {
  const q = (patch: Partial<F>) => `/admin${toQuery({ ...f, ...patch })}`;
  const chips: { key: string; label: string; href: string }[] = [];
  const nameOf = (o: Opt[], id: string) => o.find((x) => x.id === id)?.name ?? "Unknown";
  if (f.q) chips.push({ key: "q", label: `Search: ${f.q}`, href: q({ q: "" }) });
  if (f.status) chips.push({ key: "status", label: `Status: ${STATUS_LABEL[f.status]}`, href: q({ status: "" }) });
  if (f.carrier) chips.push({ key: "carrier", label: `Carrier: ${f.carrier === "none" ? "Not assigned" : nameOf(carriers, f.carrier)}`, href: q({ carrier: "" }) });
  if (f.shipper) chips.push({ key: "shipper", label: `Shipper: ${nameOf(shippers, f.shipper)}`, href: q({ shipper: "" }) });
  if (f.receiver) chips.push({ key: "receiver", label: `Receiver: ${nameOf(receivers, f.receiver)}`, href: q({ receiver: "" }) });
  if (f.size) chips.push({ key: "size", label: `${f.size} ft`, href: q({ size: 0 }) });
  if (f.when) chips.push({ key: "when", label: f.when === "custom" ? `Pickup ${f.from || "any"} to ${f.to || "any"}` : `Pickup: ${WHEN_LABEL[f.when]}`, href: q({ when: "", from: "", to: "" }) });
  if (f.needsBol) chips.push({ key: "bol", label: "Needs BOL", href: q({ needsBol: false }) });
  if (f.needsIts) chips.push({ key: "its", label: "Needs ITS number", href: q({ needsIts: false }) });

  return (
    <section aria-label="Filter and sort" data-testid="board-filters" className="mb-4">
      <div className="mb-2 flex flex-wrap gap-2">
        <Pill testid="pill-today" active={f.when === "today"} href={q({ when: f.when === "today" ? "" : "today", from: "", to: "" })}>Today</Pill>
        <Pill testid="pill-tomorrow" active={f.when === "tomorrow"} href={q({ when: f.when === "tomorrow" ? "" : "tomorrow", from: "", to: "" })}>Tomorrow</Pill>
        <Pill testid="pill-week" active={f.when === "week"} href={q({ when: f.when === "week" ? "" : "week", from: "", to: "" })}>Next 7 days</Pill>
        <Pill testid="pill-unassigned" active={f.carrier === "none"} href={q({ carrier: f.carrier === "none" ? "" : "none" })}>Not assigned</Pill>
        <Pill testid="pill-bol" active={f.needsBol} href={q({ needsBol: !f.needsBol })}>Needs BOL</Pill>
        <Pill testid="pill-its" active={f.needsIts} href={q({ needsIts: !f.needsIts })}>Needs ITS number</Pill>
      </div>
      <details className="rounded-[16px] border border-line bg-card p-3">
        <summary className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[15px] font-medium">
          Filters
          <span data-testid="filters-badge" className="rounded-full bg-mint px-2 py-0.5 text-[13px]">{chips.length}</span>
        </summary>
        <form method="get" action="/admin" className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-[13px] text-muted sm:col-span-2">Search
            <input name="q" defaultValue={f.q} maxLength={80} placeholder="ITS number, request, PO, place, carrier" className={field} />
          </label>
          <label className="block text-[13px] text-muted">Status
            <select name="status" defaultValue={f.status} className={field}>
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="block text-[13px] text-muted">Carrier
            <select name="carrier" defaultValue={f.carrier} className={field}>
              <option value="">All</option>
              <option value="none">Not assigned</option>
              {carriers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="block text-[13px] text-muted">Shipper (pickup)
            <select name="shipper" defaultValue={f.shipper} className={field}>
              <option value="">All</option>
              {shippers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="block text-[13px] text-muted">Receiver (delivery)
            <select name="receiver" defaultValue={f.receiver} className={field}>
              <option value="">All</option>
              {receivers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="block text-[13px] text-muted">Size
            <select name="size" defaultValue={f.size ? String(f.size) : ""} className={field}>
              <option value="">All</option>
              {SIZES.map((s) => <option key={s} value={s}>{s} ft</option>)}
            </select>
          </label>
          <label className="block text-[13px] text-muted">Pickup date
            <select name="when" defaultValue={f.when} className={field}>
              <option value="">Any</option>
              {(Object.keys(WHEN_LABEL) as (keyof typeof WHEN_LABEL)[]).map((w) => <option key={w} value={w}>{WHEN_LABEL[w]}</option>)}
            </select>
          </label>
          <label className="block text-[13px] text-muted">From (custom dates)
            <input type="date" name="from" defaultValue={f.from} className={field} />
          </label>
          <label className="block text-[13px] text-muted">To (custom dates)
            <input type="date" name="to" defaultValue={f.to} className={field} />
          </label>
          <label className="block text-[13px] text-muted">Sort by
            <select name="sort" defaultValue={f.sort} className={field}>
              {SORT_KEYS.map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="block text-[13px] text-muted">Order
            <select name="dir" defaultValue={f.dir} className={field}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
          <label className="block text-[13px] text-muted">View
            <select name="view" defaultValue={f.view} className={field}>
              <option value="status">By status</option>
              <option value="list">One list</option>
            </select>
          </label>
          {f.needsBol ? <input type="hidden" name="bol" value="1" /> : null}
          {f.needsIts ? <input type="hidden" name="its" value="1" /> : null}
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
            <button type="submit" data-testid="filters-apply" className="min-h-[44px] rounded-full bg-ink px-5 text-[15px] font-medium text-white">Apply</button>
            <Link href="/admin" data-testid="filters-clear" className="inline-flex min-h-[44px] items-center rounded-full border border-line bg-white px-5 text-[15px] font-medium">Clear all</Link>
          </div>
        </form>
      </details>
      {chips.length > 0 ? (
        <ul data-testid="filter-chips" className="mt-2 flex flex-wrap gap-2">
          {chips.map((c) => (
            <li key={c.key}>
              <Link href={c.href} aria-label={`Remove filter ${c.label}`} className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-ink bg-white px-3 text-[14px]">
                {c.label}<span aria-hidden="true">x</span>
              </Link>
            </li>
          ))}
          <li><Link data-testid="chips-clear" href={`/admin${toQuery({ ...f, q: "", status: "", carrier: "", shipper: "", receiver: "", size: 0, when: "", from: "", to: "", needsBol: false, needsIts: false })}`} className="inline-flex min-h-[44px] items-center px-2 text-[14px] underline">Clear all</Link></li>
        </ul>
      ) : null}
    </section>
  );
}
