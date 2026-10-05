"use client";
import { useActionState, useEffect, useState } from "react";
import { Button, Card, Field, Input, Notice } from "@/components/ui";
import { ActionForm } from "@/components/admin/ActionForm";
import type { ActionState, AdminAction } from "@/lib/admin/state";

type Item = { id: string; name: string; is_active?: boolean };

function CreateForm({ action, noun }: { action: AdminAction; noun: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const [key, setKey] = useState(0);
  useEffect(() => { if (state.ok) setKey((k) => k + 1); }, [state.ok]);
  return (
    <form key={key} action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <Field label={`New ${noun} name`}>
          <Input name="name" required maxLength={120} />
        </Field>
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Adding..." : `Add ${noun}`}</Button>
      <div className="sm:basis-full">
        {state.error ? <Notice tone="error">{state.error}</Notice> : null}
        {state.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
      </div>
    </form>
  );
}

function Row({
  item, noun, renameAction, toggleAction,
}: { item: Item; noun: string; renameAction: AdminAction; toggleAction?: AdminAction }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(renameAction, {});
  useEffect(() => { if (state.ok) setEditing(false); }, [state.ok]);
  const inactive = item.is_active === false;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className={`break-words text-[16px] font-bold ${inactive ? "text-muted" : ""}`}>{item.name}</p>
          {item.is_active !== undefined ? (
            <p className="text-[13px] text-muted">{inactive ? "Inactive" : "Active"}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Button type="button" variant="ghost" onClick={() => setEditing((e) => !e)}>
            {editing ? "Close" : "Rename"}
          </Button>
          {toggleAction ? (
            <ActionForm
              action={toggleAction}
              fields={{ id: item.id, active: inactive ? "true" : "false" }}
              label={inactive ? "Activate" : "Deactivate"}
              variant="ghost"
              showOk={false}
            />
          ) : null}
        </div>
      </div>
      {editing ? (
        <form action={formAction} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name="id" value={item.id} />
          <div className="flex-1">
            <Field label={`${noun} name`}>
              <Input name="name" required defaultValue={item.name} maxLength={120} />
            </Field>
          </div>
          <Button type="submit" disabled={pending}>{pending ? "Saving..." : "Save"}</Button>
          <div className="sm:basis-full">
            {state.error ? <Notice tone="error">{state.error}</Notice> : null}
          </div>
        </form>
      ) : null}
    </li>
  );
}

export function NameManager({
  noun, items, createAction, renameAction, toggleAction,
}: {
  noun: string; items: Item[];
  createAction: AdminAction; renameAction: AdminAction; toggleAction?: AdminAction;
}) {
  return (
    <div className="space-y-4">
      <Card><CreateForm action={createAction} noun={noun} /></Card>
      <Card>
        {items.length === 0 ? (
          <p className="text-[15px] text-muted">No {noun}s yet. Add the first one above.</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <Row key={i.id} item={i} noun={noun} renameAction={renameAction} toggleAction={toggleAction} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
