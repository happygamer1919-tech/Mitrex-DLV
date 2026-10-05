"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, Field, Input, Notice } from "@/components/ui";

export function LoginForm({ initialError }: { initialError: string | null }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(initialError);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState("sending");
    const supabase = createClient();
    // Invite-only: shouldCreateUser is false. The response is generic so emails cannot be enumerated.
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error && /rate|limit/i.test(error.message)) {
      setError("Too many requests. Wait a minute and try again.");
      setState("idle");
      return;
    }
    setState("sent");
  }

  if (state === "sent") {
    return (
      <Card>
        <h1 className="mb-2 text-[20px] font-bold">Check your email</h1>
        <p className="text-[15px] text-muted">
          If {email} has access, a sign-in link is on its way. Open it on this device.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <h1 className="mb-1 text-[20px] font-bold">Sign in</h1>
      <p className="mb-4 text-[15px] text-muted">Enter your email and we send you a one-time link. Access is by invitation.</p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" required autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" disabled={state === "sending"} className="w-full">
          {state === "sending" ? "Sending..." : "Email me a sign-in link"}
        </Button>
      </form>
    </Card>
  );
}
