import { Resend } from "resend";

// An attachment is sent to Resend as a base64 string (the SDK passes a string through unchanged).
export type EmailAttachment = { filename: string; content: Buffer; contentType?: string };

// Server side only. Never throws: a failed notification must not fail the booking.
export async function sendEmail(
  to: string[], subject: string, text: string, attachments: EmailAttachment[] = [],
): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM;
  if (!key || !from || to.length === 0) return false;
  try {
    const resend = new Resend(key);
    const { error } = await resend.emails.send({
      from, to, subject, text,
      ...(attachments.length > 0
        ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), contentType: a.contentType })) }
        : {}),
    });
    return !error;
  } catch {
    return false;
  }
}
