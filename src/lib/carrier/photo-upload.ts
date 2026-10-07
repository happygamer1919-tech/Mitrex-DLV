// Browser only. Stores one load photo (pickup or delivery): upload the already downscaled JPEG to the private bucket,
// insert one load_documents row. The official time of the photo is the server time of the insert (created_at);
// capturedAt is the browser clock and is stored for reference only. One storage path per captured photo (pathRef),
// reused by every retry of that photo, so a retry finds the earlier upload instead of leaving a second copy.
import { createClient } from "@/lib/supabase/client";
import type { PhotoKind } from "@/lib/carrier/photos";

export type PhotoResult = { ok: true } | { ok: false; error: string };

export async function storeLoadPhoto(opts: {
  loadId: string;
  userId: string;
  kind: PhotoKind;
  blob: Blob;
  capturedAt: string; // ISO instant from the browser clock
  pathRef: { current: string | null };
}): Promise<PhotoResult> {
  const { loadId, userId, kind, blob, capturedAt, pathRef } = opts;
  const path = (pathRef.current ??= `${loadId}/${kind}/${crypto.randomUUID()}.jpg`);
  const supabase = createClient();
  const up = await supabase.storage.from("documents").upload(path, blob, { contentType: "image/jpeg", upsert: false });
  const exists = up.error && (/already exists|duplicate/i.test(up.error.message) || String((up.error as { statusCode?: string }).statusCode) === "409");
  if (up.error && !exists) {
    const code = String((up.error as { statusCode?: string }).statusCode);
    if (code === "403" || /row-level security|violates/i.test(up.error.message)) {
      return { ok: false, error: "This photo cannot be added any more because the load has moved on. Refresh the page." };
    }
    return { ok: false, error: "The photo did not upload. Check your connection and tap Try again." };
  }
  const ins = await supabase
    .from("load_documents")
    .insert({ load_id: loadId, kind, storage_path: path, uploaded_by: userId, captured_at: capturedAt });
  if (ins.error && ins.error.code !== "23505") {
    if (/at most 6 photos/i.test(ins.error.message)) {
      await supabase.storage.from("documents").remove([path]);
      pathRef.current = null;
      return { ok: false, error: "This load already has 6 photos of this kind. Remove one first." };
    }
    if (ins.error.code === "42501" || /row-level security/i.test(ins.error.message)) {
      return { ok: false, error: "This photo cannot be added any more because the load has moved on. Refresh the page." };
    }
    return { ok: false, error: "The photo could not be saved. Tap Try again." };
  }
  return { ok: true };
}
