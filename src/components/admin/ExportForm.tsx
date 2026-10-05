"use client";
import { useState } from "react";
import { Button, Card, Field, Input, Notice } from "@/components/ui";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";

export function ExportForm({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [error, setError] = useState("");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    const from = String(fd.get("from") ?? "");
    const to = String(fd.get("to") ?? "");
    if (!from || !to) { e.preventDefault(); setError("Choose both a start and an end date."); return; }
    if (from > to) { e.preventDefault(); setError("The start date must be on or before the end date."); return; }
    setError("");
  }

  return (
    <Card>
      <form method="get" action="/admin/export/csv" onSubmit={onSubmit} className="space-y-4">
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-muted">Filter dates by</legend>
          <label className="flex min-h-[44px] items-center gap-3 text-[15px]">
            <input type="radio" name="by" value="pickup_date" defaultChecked className="h-5 w-5 accent-[#020814]" />
            Pickup date
          </label>
          <label className="flex min-h-[44px] items-center gap-3 text-[15px]">
            <input type="radio" name="by" value="created_at" className="h-5 w-5 accent-[#020814]" />
            Date requested (created)
          </label>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From"><Input type="date" name="from" defaultValue={defaultFrom} required /></Field>
          <Field label="To"><Input type="date" name="to" defaultValue={defaultTo} required /></Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-muted">Status (leave all unchecked for every status)</legend>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {(Object.keys(STATUS_LABEL) as LoadStatus[]).map((s) => (
              <label key={s} className="flex min-h-[44px] items-center gap-3 text-[15px]">
                <input type="checkbox" name="status" value={s} className="h-5 w-5 accent-[#020814]" />
                {STATUS_LABEL[s]}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-[13px] text-muted">Dates are Eastern time. Timestamps in the file are Eastern time (YYYY-MM-DD HH:mm).</p>
        <Button type="submit" variant="dark">Download CSV</Button>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Card>
  );
}
