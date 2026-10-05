import { MAIL_API } from "./env";

// Reads the newest 6 digit code sent to an address from the local mail catcher (Mailpit API).
export async function latestCode(to: string, notBeforeMs: number, timeoutMs = 30_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const res = await fetch(`${MAIL_API}/search?query=${encodeURIComponent("to:" + to)}&limit=10`);
    if (res.ok) {
      const body = (await res.json()) as { messages?: { ID: string; Created: string }[] };
      for (const msg of body.messages ?? []) {
        if (new Date(msg.Created).getTime() < notBeforeMs - 2000) continue;
        const full = await fetch(`${MAIL_API}/message/${msg.ID}`);
        if (!full.ok) continue;
        const m = (await full.json()) as { Text?: string; HTML?: string };
        const hit = /\b(\d{6})\b/.exec(`${m.Text ?? ""} ${m.HTML ?? ""}`);
        if (hit) return hit[1];
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no code mail for ${to}`);
}

export async function clearMail() {
  await fetch(`${MAIL_API}/messages`, { method: "DELETE" }).catch(() => {});
}
