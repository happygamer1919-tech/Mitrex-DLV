import { MAIL_API } from "./env";
import { assertLocalUrl } from "./guard";

// Reads the newest numeric login code sent to an address from the local mail catcher (Mailpit API).
// The local stack sends an 8 digit code (supabase/config.toml otp_length = 8).
export async function latestCode(to: string, notBeforeMs: number, timeoutMs = 30_000, fudgeMs = 2000): Promise<string> {
  assertLocalUrl(MAIL_API, "mail api");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const res = await fetch(`${MAIL_API}/search?query=${encodeURIComponent("to:" + to)}&limit=10`);
    if (res.ok) {
      const body = (await res.json()) as { messages?: { ID: string; Created: string }[] };
      for (const msg of body.messages ?? []) {
        if (new Date(msg.Created).getTime() < notBeforeMs - fudgeMs) continue;
        const full = await fetch(`${MAIL_API}/message/${msg.ID}`);
        if (!full.ok) continue;
        const m = (await full.json()) as { Text?: string; HTML?: string };
        const hit = /\b(\d{6,8})\b/.exec(m.Text ?? "") ?? /\b(\d{8})\b/.exec(m.HTML ?? "");
        if (hit) return hit[1];
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no code mail for ${to}`);
}

export async function clearMail() {
  assertLocalUrl(MAIL_API, "mail api");
  await fetch(`${MAIL_API}/messages`, { method: "DELETE" }).catch(() => {});
}
