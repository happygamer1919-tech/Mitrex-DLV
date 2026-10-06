// Validates the post-login return path ("next"). Anything that could leave this site, or loop
// through the auth pages, is ignored (null) so the user lands on their role home instead.
export function safeNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return null;
  const candidates = [raw];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {
    return null;
  }
  for (const v of candidates) {
    // Must be a single-slash path: no protocol-relative "//", no backslash, no control characters.
    if (!v.startsWith("/") || v.startsWith("//")) return null;
    if (v.includes("\\")) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  }
  let url: URL;
  try {
    url = new URL(raw, "http://dlv.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://dlv.invalid") return null;
  const path = url.pathname;
  if (path === "/login" || path.startsWith("/login/") || path === "/auth" || path.startsWith("/auth/")) return null;
  return raw;
}

// "/login" or "/login?next=<encoded path>" for the given location (pathname plus search).
export function loginPathFor(location: string): string {
  const ok = safeNext(location);
  return ok && ok !== "/" ? `/login?next=${encodeURIComponent(ok)}` : "/login";
}
