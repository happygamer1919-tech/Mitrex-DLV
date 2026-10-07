import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { assertLocalUrl } from "./guard";

// A tiny local stand-in for the Resend HTTP API (the resend SDK honours RESEND_BASE_URL).
//   POST /emails      records the JSON body, answers 200 {id} (or the status set below)
//   GET  /__emails    every recorded body, oldest first
//   POST /__status    {"status": 500} makes POST /emails fail with that status; {"status": 200} restores it
// Local only: it binds 127.0.0.1 and the URL is checked by assertLocalUrl wherever it is used.
export const MAIL_MOCK_PORT = Number(process.env.E2E_MAIL_MOCK_PORT ?? 3299);
export const MAIL_MOCK_URL = `http://127.0.0.1:${MAIL_MOCK_PORT}`;
assertLocalUrl(MAIL_MOCK_URL, "mail mock url");

// Attachments are recorded as metadata (filename, decoded byte length, content type, sha256 of the bytes), not content.
export type SentAttachment = { filename: string; bytes: number; contentType: string | null; sha256: string };
export type SentEmail = { from: string; to: string[]; subject: string; text?: string; html?: string; attachments: SentAttachment[] };

export function startMailMock(): Promise<Server> {
  assertLocalUrl(MAIL_MOCK_URL, "mail mock url");
  const sent: SentEmail[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/__emails") return json(200, sent);
      if (req.method === "POST" && req.url === "/__status") {
        status = Number((JSON.parse(raw || "{}") as { status?: number }).status ?? 200);
        return json(200, { status });
      }
      if (req.method === "POST" && req.url === "/emails") {
        let body: SentEmail | null = null;
        try {
          const j = JSON.parse(raw) as Omit<SentEmail, "attachments"> & {
            attachments?: { filename: string; content?: string; content_type?: string }[];
          };
          body = {
            ...j,
            attachments: (j.attachments ?? []).map((a) => {
              const buf = Buffer.from(a.content ?? "", "base64");
              return { filename: a.filename, bytes: buf.length, contentType: a.content_type ?? null, sha256: createHash("sha256").update(buf).digest("hex") };
            }),
          };
        } catch { body = null; }
        if (body) sent.push(body); // recorded even when the mock then answers with a failure
        if (status !== 200) return json(status, { name: "application_error", statusCode: status, message: "mock failure" });
        return json(200, { id: `mock-${sent.length}` });
      }
      return json(404, { message: "not found" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MAIL_MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

export async function sentEmails(): Promise<SentEmail[]> {
  assertLocalUrl(MAIL_MOCK_URL, "mail mock url");
  const res = await fetch(`${MAIL_MOCK_URL}/__emails`);
  return (await res.json()) as SentEmail[];
}

export async function setMockStatus(status: number): Promise<void> {
  assertLocalUrl(MAIL_MOCK_URL, "mail mock url");
  await fetch(`${MAIL_MOCK_URL}/__status`, { method: "POST", body: JSON.stringify({ status }) });
}
