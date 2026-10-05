type DbError = { message?: string; code?: string } | null | undefined;

// Turns a Postgres or PostgREST error into a plain sentence. Our own function errors
// (raise exception) are already human readable and pass through unchanged.
export function plainError(error: DbError, fallback = "Something went wrong. Please try again."): string {
  if (!error) return fallback;
  const msg = error.message ?? "";
  if (error.code === "23505") return "That name or email already exists.";
  if (error.code === "23503") return "This record is still used by other data, so it cannot be removed.";
  if (error.code === "42501" && /row-level security/i.test(msg)) return "You do not have permission to do that.";
  if (error.code === "23514") return "One of the values is not allowed. Check the form and try again.";
  return msg || fallback;
}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
