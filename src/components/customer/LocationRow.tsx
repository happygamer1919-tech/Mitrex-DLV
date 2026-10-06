"use client";

import { useState, useTransition } from "react";
import { Button, Card, Field, Input } from "@/components/ui";
import { saveDefaultContact } from "@/lib/customer/actions";
import type { Location } from "@/lib/types";

function Flag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-[#DCE6F5] px-3 py-1 text-[13px] font-medium">{children}</span>;
}

export function LocationRow({ location }: { location: Location }) {
  const [name, setName] = useState(location.default_contact_name ?? "");
  const [phone, setPhone] = useState(location.default_contact_phone ?? "");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = name !== (location.default_contact_name ?? "") || phone !== (location.default_contact_phone ?? "");

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await saveDefaultContact(location.id, name, phone);
      setMsg(res.error ? { tone: "error", text: res.error } : { tone: "ok", text: "Saved." });
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[18px] font-bold break-words">{location.name}</h2>
          <p className="text-[15px] text-muted break-words">
            {location.address_line}, {location.city}, {location.province}
            {location.postal_code ? ` ${location.postal_code}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {location.can_ship ? <Flag>Can ship</Flag> : null}
          {location.can_receive ? <Flag>Can receive</Flag> : null}
          {location.requires_moffett ? <Flag>Moffett</Flag> : null}
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Default contact name">
          <Input value={name} autoComplete="off" onChange={(e) => { setName(e.target.value); setMsg(null); }} />
        </Field>
        <Field label="Default contact phone">
          <Input type="tel" inputMode="tel" value={phone} autoComplete="off"
            onChange={(e) => { setPhone(e.target.value); setMsg(null); }} />
        </Field>
        <Button type="button" variant="dark" disabled={pending || !dirty} onClick={save}>
          {pending ? "Saving..." : "Save contact"}
        </Button>
      </div>
      {msg ? (
        <p role={msg.tone === "error" ? "alert" : "status"}
          className={`mt-2 text-[13px] font-medium ${msg.tone === "error" ? "text-[#7A1F1F]" : "text-[#12875A]"}`}>
          {msg.text}
        </p>
      ) : null}
    </Card>
  );
}
