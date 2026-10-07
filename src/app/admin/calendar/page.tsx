import Link from "next/link";
import { Shell } from "@/components/Shell";
import { LiveRefresh } from "@/components/LiveRefresh";
import { LoadNumber } from "@/components/LoadNumber";
import { Card, Notice, PageTitle, StatusChip, btnClass } from "@/components/ui";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { todayEastern } from "@/lib/format";
import {
  WEEKDAYS, addDays, addMonths, dayLabel, endOfMonth, isValidDay, monthLabel, startOfMonth, startOfWeek,
} from "@/lib/admin/cal";
import { BOARD_SELECT, pickupTimeLabel, routeOf, type BoardLoad } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

function Item({ l }: { l: BoardLoad }) {
  return (
    <Link href={`/admin/loads/${l.id}`} className="block rounded-[12px] border border-line bg-white p-2 hover:border-ink">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-[13px] font-bold"><LoadNumber l={l} audience="staff" /></span>
        <StatusChip status={l.status} />
      </div>
      <p className="mt-1 text-[13px] text-muted">{pickupTimeLabel(l)}</p>
      <p className="break-words text-[13px]">{routeOf(l)}</p>
    </Link>
  );
}

export default async function CalendarPage({
  searchParams,
}: { searchParams: Promise<{ view?: string; date?: string }> }) {
  const profile = await requireStaff();
  const sp = await searchParams;
  const view = sp.view === "month" ? "month" : "week";
  const today = todayEastern();
  const anchor = isValidDay(sp.date) ? sp.date : today;

  const gridStart = view === "week" ? startOfWeek(anchor) : startOfWeek(startOfMonth(anchor));
  const monthEnd = endOfMonth(anchor);
  const gridEnd = view === "week" ? addDays(gridStart, 6) : addDays(startOfWeek(monthEnd), 6);
  const days: string[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("loads").select(BOARD_SELECT)
    .gte("pickup_date", gridStart).lte("pickup_date", gridEnd)
    .order("pickup_time_start").limit(1000);
  const loads = (data ?? []) as unknown as BoardLoad[];
  const byDay = new Map<string, BoardLoad[]>();
  loads.forEach((l) => byDay.set(l.pickup_date, [...(byDay.get(l.pickup_date) ?? []), l]));

  const prev = view === "week" ? addDays(anchor, -7) : addMonths(anchor, -1);
  const next = view === "week" ? addDays(anchor, 7) : addMonths(anchor, 1);
  const href = (v: string, d: string) => `/admin/calendar?view=${v}&date=${d}`;
  const title = view === "week" ? `${dayLabel(gridStart)} to ${dayLabel(gridEnd)}` : monthLabel(anchor);
  const inMonth = (d: string) => view === "week" || d.slice(0, 7) === anchor.slice(0, 7);
  const agendaDays = days.filter((d) => inMonth(d) && (byDay.get(d)?.length ?? 0) > 0);

  return (
    <Shell profile={profile}>
      <LiveRefresh />
      <PageTitle>Calendar</PageTitle>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={href("week", anchor)} className={btnClass(view === "week" ? "dark" : "ghost")}>Week</Link>
        <Link href={href("month", anchor)} className={btnClass(view === "month" ? "dark" : "ghost")}>Month</Link>
        <span className="mx-1" />
        <Link href={href(view, prev)} aria-label="Previous" className={btnClass("ghost")}>Prev</Link>
        <Link href={href(view, today)} className={btnClass("ghost")}>Today</Link>
        <Link href={href(view, next)} aria-label="Next" className={btnClass("ghost")}>Next</Link>
      </div>
      <h2 className="mb-3 text-[20px] font-bold">{title}</h2>
      {error ? <div className="mb-3"><Notice tone="error">Could not load loads: {error.message}</Notice></div> : null}
      <p className="mb-3 text-[13px] text-muted">Loads are placed by pickup date. Times are Eastern (ET).</p>

      <div className="hidden md:block">
        <div className="grid grid-cols-7 gap-2 pb-2 text-[13px] font-medium text-muted">
          {WEEKDAYS.map((w) => <div key={w}>{w}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {days.map((d) => {
            const list = byDay.get(d) ?? [];
            return (
              <div
                key={d}
                className={`min-h-[110px] min-w-0 rounded-[12px] border p-2 ${d === today ? "border-ink border-2" : "border-line"} ${inMonth(d) ? "bg-card" : "bg-transparent opacity-60"}`}
              >
                <p className="mb-1 text-[13px] font-bold">{Number(d.slice(8))}</p>
                <div className="space-y-2">{list.map((l) => <Item key={l.id} l={l} />)}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-3 md:hidden">
        {agendaDays.length === 0 ? (
          <Card><p className="text-[15px] text-muted">No loads with a pickup in this period.</p></Card>
        ) : agendaDays.map((d) => (
          <section key={d}>
            <h3 className={`mb-2 text-[15px] font-bold ${d === today ? "text-ink underline" : ""}`}>
              {dayLabel(d, true)}{d === today ? " (today)" : ""}
            </h3>
            <div className="space-y-2">{(byDay.get(d) ?? []).map((l) => <Item key={l.id} l={l} />)}</div>
          </section>
        ))}
      </div>
      {loads.length === 0 ? <p className="mt-4 hidden text-[15px] text-muted md:block">No loads with a pickup in this period.</p> : null}
    </Shell>
  );
}
