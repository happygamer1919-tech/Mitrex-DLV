// Admin only permanent delete of a load (DLV-027, R38). Pure core: no framework imports, so it is unit tested with
// injected dependencies (including a storage remover that fails). The server action in delete-load-action.ts wires
// the real clients. Order: database function first (checks the admin, the typed text, writes the audit row, deletes
// the load, returns the document paths), then the files, then the orphan log when the files could not be removed.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Same shape as dlv_can_access_doc and the load_documents CHECK: {load uuid}/{bol|pod}/{file uuid}.{ext}
export const DOC_PATH_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(bol|pod)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;

export const MAX_CONFIRM_LENGTH = 40;

type DbError = { message?: string; code?: string } | null | undefined;

export type DeleteDeps = {
  // public.delete_load_forever, called with the admin's own session
  rpcDelete: (loadId: string, typed: string) => Promise<{ data: unknown; error: DbError }>;
  // storage remove with the service role client
  removeFiles: (paths: string[]) => Promise<{ error: DbError } | void>;
  // public.record_load_deletion_orphans, called with the admin's own session
  recordOrphans: (loadId: string, paths: string[]) => Promise<{ error: DbError }>;
};

export type DeleteOutcome =
  | { ok: false; error: string }
  | { ok: true; number: string; removed: number; orphaned: number; orphansLogged: boolean };

export function deleteErrorMessage(error: DbError): string {
  const msg = error?.message ?? "";
  if (error?.code === "42501" || /not authorized/i.test(msg)) return "Only an admin can delete a load.";
  if (/confirmation does not match/i.test(msg)) return "The text you typed does not match. Nothing was deleted.";
  if (error?.code === "P0002" || /load not found/i.test(msg)) return "This load no longer exists.";
  return "The load could not be deleted. Nothing was changed. Please try again.";
}

export async function deleteLoadCore(deps: DeleteDeps, loadId: unknown, typed: unknown): Promise<DeleteOutcome> {
  if (typeof loadId !== "string" || !UUID_RE.test(loadId)) return { ok: false, error: "Load not found." };
  if (typeof typed !== "string") return { ok: false, error: "Type the load number to confirm." };
  const text = typed.trim();
  if (!text) return { ok: false, error: "Type the load number to confirm." };
  if (text.length > MAX_CONFIRM_LENGTH) return { ok: false, error: "The text you typed does not match. Nothing was deleted." };

  const res = await deps.rpcDelete(loadId, text);
  if (res.error) return { ok: false, error: deleteErrorMessage(res.error) };
  // From here the load is gone for good. Never report a failure again.
  const returned = Array.isArray(res.data) ? res.data.filter((p): p is string => typeof p === "string") : [];
  const valid = returned.filter((p) => DOC_PATH_RE.test(p) && p.startsWith(`${loadId}/`));
  const invalid = returned.length - valid.length;

  let failed: string[] = [];
  if (valid.length > 0) {
    try {
      const r = await deps.removeFiles(valid);
      if (r && r.error) failed = valid;
    } catch {
      failed = valid;
    }
  }
  let orphansLogged = true;
  if (failed.length > 0) {
    try {
      const r = await deps.recordOrphans(loadId, failed);
      if (r.error) orphansLogged = false;
    } catch {
      orphansLogged = false;
    }
  }
  return {
    ok: true,
    number: text,
    removed: valid.length - failed.length,
    orphaned: failed.length + invalid,
    orphansLogged,
  };
}

// Banner on /admin after a delete. The numbers come from the URL, so they are validated before they are shown.
export function deletedBanner(params: { deleted?: string; orphans?: string; logged?: string }): { tone: "ok" | "warn"; text: string } | null {
  const num = params.deleted;
  if (!num || !/^[A-Za-z0-9-]{1,40}$/.test(num)) return null;
  const n = Number(params.orphans ?? "0");
  if (Number.isInteger(n) && n > 0 && n <= 1000) {
    const files = `${n} ${n === 1 ? "file" : "files"}`;
    return params.logged === "0"
      ? { tone: "warn", text: `Load ${num} was deleted. ${files} could not be removed and the cleanup log also failed. Tell the developer.` }
      : { tone: "warn", text: `The load was deleted. ${files} could not be removed and ${n === 1 ? "was" : "were"} logged for cleanup.` };
  }
  return { tone: "ok", text: `Load ${num} deleted forever` };
}
