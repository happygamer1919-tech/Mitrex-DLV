"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, Field, Input, Notice } from "@/components/ui";
import { safeNext } from "@/lib/safe-next";

const RESEND_SECONDS = 30;

type AuthErr = { message?: string; status?: number; name?: string; code?: string };

function isRateLimit(e: AuthErr) {
  return e.status === 429 || /rate|limit|too many|seconds/i.test(`${e.message ?? ""} ${e.code ?? ""}`);
}
function isNetwork(e: AuthErr) {
  return e.status === 0 || /fetch|network/i.test(`${e.name ?? ""} ${e.message ?? ""}`);
}

// Hosted Supabase sends 8 digit codes by default. The code auto-submits at OTP_LENGTH; the
// Sign in button accepts anything from MIN_CODE_LENGTH so a project set to 6 digits also works.
const OTP_LENGTH = 8;
const MIN_CODE_LENGTH = 6;

export function LoginForm({ initialError, nextPath }: { initialError: string | null; nextPath: string | null }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const verifying = useRef(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  // Returns true when the request was accepted or answered generically.
  const sendCode = useCallback(async (address: string): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      // Invite-only: shouldCreateUser is false. The UI never reveals whether an email exists,
      // so every non-throttle, non-network answer (including "signups not allowed") looks the same.
      const { error: err } = await supabase.auth.signInWithOtp({
        email: address,
        options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (err && isRateLimit(err)) {
        setError("Too many requests. Wait a minute and try again.");
        return false;
      }
      if (err && isNetwork(err)) {
        setError("Network problem. Check your connection and try again.");
        return false;
      }
      return true;
    } catch {
      setError("Network problem. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    setEmail(address);
    if (await sendCode(address)) {
      setCode("");
      setStep("code");
      setSecondsLeft(RESEND_SECONDS);
    }
  }

  async function onResend() {
    if (busy || secondsLeft > 0) return;
    if (await sendCode(email)) {
      setCode("");
      setSecondsLeft(RESEND_SECONDS);
      codeRef.current?.focus();
    }
  }

  async function verify(token: string) {
    if (verifying.current) return;
    verifying.current = true;
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.verifyOtp({ email, token, type: "email" });
      if (err) {
        if (isRateLimit(err)) setError("Too many requests. Wait a minute and try again.");
        else if (isNetwork(err)) setError("Network problem. Check your connection and try again.");
        else setError("That code is wrong or has expired. Check it, or tap Resend code.");
        setCode("");
        setBusy(false);
        verifying.current = false;
        codeRef.current?.focus();
        return;
      }
      // Hard navigation so the server sees the cookie session. Back to the page the user was on when
      // the session ended (validated again here), otherwise "/" routes by role.
      window.location.assign(safeNext(nextPath) ?? "/");
    } catch {
      setError("Network problem. Check your connection and try again.");
      setCode("");
      setBusy(false);
      verifying.current = false;
    }
  }

  function onCodeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH);
    setCode(digits);
    if (digits.length === OTP_LENGTH) void verify(digits);
  }

  function useDifferentEmail() {
    setStep("email");
    setCode("");
    setError(null);
    setSecondsLeft(0);
    verifying.current = false;
  }

  if (step === "code") {
    return (
      <Card>
        <h1 className="mb-1 text-[20px] font-bold">Enter your code</h1>
        <p className="mb-4 break-words text-[15px] text-muted">
          If {email} has access, a sign-in code is on its way. You can also tap the link in the email.
        </p>
        <div className="space-y-4">
          <Field label="Sign-in code">
            <input
              ref={codeRef}
              data-testid="login-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={OTP_LENGTH}
              value={code}
              disabled={busy}
              onChange={onCodeChange}
              aria-label="Sign-in code"
              className="w-full min-h-[56px] rounded-[12px] border border-line bg-white px-3 text-center text-[28px] font-bold tracking-[0.2em] text-ink"
            />
          </Field>
          <Button
            type="button"
            data-testid="login-verify"
            disabled={busy || code.length < MIN_CODE_LENGTH}
            onClick={() => void verify(code)}
            className="min-h-[48px] w-full"
          >
            Sign in
          </Button>
          {busy ? <Notice tone="info">Checking code...</Notice> : null}
          {error ? <div data-testid="login-error"><Notice tone="error">{error}</Notice></div> : null}
          <Button
            type="button"
            variant="ghost"
            data-testid="login-resend"
            disabled={busy || secondsLeft > 0}
            onClick={onResend}
            className="min-h-[48px] w-full"
          >
            {secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : "Resend code"}
          </Button>
          <button type="button" onClick={useDifferentEmail} className="min-h-[48px] w-full cursor-pointer text-[15px] font-medium text-ink underline">
            Use a different email
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-1 text-[20px] font-bold">Sign in</h1>
      <p className="mb-4 text-[15px] text-muted">Enter your email and we send you a sign-in code. Access is by invitation.</p>
      <form onSubmit={onSend} className="space-y-4">
        <Field label="Email">
          <Input
            data-testid="login-email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-[48px]"
          />
        </Field>
        {error ? <div data-testid="login-error"><Notice tone="error">{error}</Notice></div> : null}
        <Button type="submit" data-testid="login-send" disabled={busy} className="min-h-[48px] w-full">
          {busy ? "Sending..." : "Send code"}
        </Button>
      </form>
    </Card>
  );
}
