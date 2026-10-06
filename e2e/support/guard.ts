// LOCAL-ONLY GUARD for every e2e run. Compares the parsed host exactly, never a substring.
export function assertLocalUrl(value: string | undefined, label: string): void {
  let host: string | null = null;
  try {
    host = new URL(value ?? "").hostname;
  } catch {
    host = null;
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`REFUSE: ${label} is not a local address (host must be exactly 127.0.0.1 or localhost).`);
  }
}
