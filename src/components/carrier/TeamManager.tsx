"use client";

import { useState } from "react";
import { Button, Card, Field, Input, Notice } from "@/components/ui";
import { addDriver, removeDriver } from "@/app/team/actions";

export type Member = { id: string; email: string; full_name: string | null; role: string; isSelf: boolean };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function MemberRow({ m, onResult }: { m: Member; onResult: (r: { ok: boolean; text: string }) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const removable = m.role === "carrier_driver" && !m.isSelf;

  async function remove() {
    setBusy(true);
    try {
      const res = await removeDriver(m.id);
      onResult({ ok: res.ok, text: res.ok ? res.message : res.error });
      if (!res.ok) setConfirming(false);
    } catch {
      onResult({ ok: false, text: "Something went wrong. Try again." });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="break-words text-[16px] font-bold">
            {m.full_name || m.email}
            {m.isSelf ? <span className="ml-2 text-[13px] font-medium text-muted">(you)</span> : null}
          </div>
          {m.full_name ? <div className="break-all text-[15px] text-muted">{m.email}</div> : null}
          <div className="text-[13px] font-medium text-muted">{m.role === "carrier_owner" ? "Owner" : "Driver"}</div>
        </div>
        {removable && !confirming ? (
          <Button type="button" variant="danger" className="min-h-[48px]" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        ) : null}
      </div>
      {removable && confirming ? (
        <div className="mt-3 rounded-[12px] bg-[#F7D9D9] p-3 text-[#7A1F1F]">
          <p className="mb-3 text-[15px]">
            Remove {m.full_name || m.email}? They lose access to all loads right away.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="dark" className="min-h-[48px]" disabled={busy} onClick={remove}>
              {busy ? "Removing..." : "Yes, remove"}
            </Button>
            <Button type="button" variant="white" className="min-h-[48px]" disabled={busy} onClick={() => setConfirming(false)}>
              Keep driver
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function TeamManager({ members }: { members: Member[] }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const clean = email.trim();
    if (!EMAIL_RE.test(clean)) {
      setFieldError("Enter a valid email address.");
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      const res = await addDriver(clean, name);
      setMsg({ ok: res.ok, text: res.ok ? res.message : res.error });
      if (res.ok) {
        setEmail("");
        setName("");
      }
    } catch {
      setMsg({ ok: false, text: "Something went wrong. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="text-ink">
        <h2 className="mb-1 text-[20px] font-bold">Add a driver</h2>
        <p className="mb-4 text-[15px] text-muted">Drivers see the same loads your company sees. They sign in with a one-time email link.</p>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Driver email">
            <Input
              type="email"
              inputMode="email"
              autoComplete="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              aria-invalid={fieldError ? true : undefined}
            />
          </Field>
          {fieldError ? <p className="text-[13px] font-medium text-[#7A1F1F]">{fieldError}</p> : null}
          <Field label="Full name (optional)">
            <Input type="text" autoComplete="off" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </Field>
          <Button type="submit" variant="dark" className="min-h-[52px] w-full" disabled={busy}>
            {busy ? "Adding..." : "Add driver"}
          </Button>
        </form>
      </Card>

      {msg ? <Notice tone={msg.ok ? "ok" : "error"}>{msg.text}</Notice> : null}

      <Card className="text-ink">
        <h2 className="mb-2 text-[20px] font-bold">Your team</h2>
        {members.length === 0 ? (
          <p className="text-[15px] text-muted">No team members yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {members.map((m) => (
              <MemberRow key={m.id} m={m} onResult={(r) => setMsg(r)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
