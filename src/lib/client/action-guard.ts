import { loginPathFor } from "@/lib/safe-next";

// Watchdog for every browser-side mutation. Default 25 s; NEXT_PUBLIC_ACTION_TIMEOUT_MS overrides it
// (inlined at build time, used by the e2e web server).
export const ACTION_TIMEOUT_MS = (() => {
  const n = Number(process.env.NEXT_PUBLIC_ACTION_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 25_000;
})();

// Body the proxy answers to a server action call that has no session.
export const SESSION_EXPIRED_BODY = "SESSION_EXPIRED";

export class ActionTimeoutError extends Error {
  constructor() {
    super("action timed out");
    this.name = "ActionTimeoutError";
  }
}

// Rejects with ActionTimeoutError when the promise has not settled in time. The underlying request
// cannot be cancelled, so callers must ignore its late result (see the `cancelled` token in LoadActions).
export function withTimeout<T>(p: Promise<T>, ms: number = ACTION_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ActionTimeoutError()), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export function failure(e: unknown): { message: string; sessionExpired: boolean } {
  const text = e instanceof Error ? e.message : "";
  if (text.includes(SESSION_EXPIRED_BODY)) return { message: "Your session has expired. Sending you to sign in.", sessionExpired: true };
  if (e instanceof ActionTimeoutError) {
    return { message: "This is taking too long. Check your connection and try again.", sessionExpired: false };
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { message: "You are offline. Reconnect, then try again.", sessionExpired: false };
  }
  if (e instanceof TypeError) {
    return { message: "Could not reach the server. Check your connection and try again.", sessionExpired: false };
  }
  return { message: "Something went wrong. Try again.", sessionExpired: false };
}

// Sends the user to sign in and back to the page they are on.
export function goToLogin(): void {
  window.location.assign(loginPathFor(window.location.pathname + window.location.search));
}
