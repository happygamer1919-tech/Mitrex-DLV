"use client";
import { useActionState, useEffect, useState } from "react";
import { Button, Notice } from "@/components/ui";
import type { ActionState, AdminAction } from "@/lib/admin/state";

type Props = {
  action: AdminAction;
  fields?: Record<string, string>;
  label: string;
  pendingLabel?: string;
  variant?: "primary" | "dark" | "ghost" | "neon" | "white" | "danger";
  // When set, a first click asks for confirmation with this text.
  confirm?: string;
  confirmLabel?: string;
  showOk?: boolean;
};

// One-button form for a server action: pending state, optional confirm step, inline error.
export function ActionForm({
  action, fields = {}, label, pendingLabel, variant = "dark", confirm, confirmLabel, showOk = true,
}: Props) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (state.ok || state.error) setAsking(false);
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {confirm && !asking ? (
        <Button type="button" variant={variant} onClick={() => setAsking(true)}>{label}</Button>
      ) : null}
      {confirm && asking ? (
        <div className="flex flex-col gap-2">
          <p className="text-[15px]">{confirm}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? (pendingLabel ?? "Working...") : (confirmLabel ?? "Yes, continue")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)} disabled={pending}>Keep</Button>
          </div>
        </div>
      ) : null}
      {!confirm ? (
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? (pendingLabel ?? "Working...") : label}
        </Button>
      ) : null}
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {showOk && state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
    </form>
  );
}
