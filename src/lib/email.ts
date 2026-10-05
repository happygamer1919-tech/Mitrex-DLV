import { Resend } from "resend";

// Server side only. Never throws: a failed notification must not fail the booking.
export async function sendEmail(to: string[], subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM;
  if (!key || !from || to.length === 0) return false;
  try {
    const resend = new Resend(key);
    const { error } = await resend.emails.send({ from, to, subject, text });
    return !error;
  } catch {
    return false;
  }
}
