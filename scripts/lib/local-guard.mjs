// LOCAL-ONLY GUARD. Any script that touches a database must call assertLocal() first.
// It compares the PARSED host exactly (never a substring) and halts the process on anything else.
export function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

export function assertLocal(label, value) {
  const host = hostOf(value || "");
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`REFUSE: ${label} is not a local address (host must be exactly 127.0.0.1 or localhost).`);
    process.exit(2);
  }
}
