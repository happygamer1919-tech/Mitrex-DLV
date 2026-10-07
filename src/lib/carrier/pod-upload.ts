// Browser only. Stores one POD (a photo, or a PDF chosen as a file): compress to at most 1600px JPEG, upload to the private bucket, insert one
// load_documents row. One storage path per chosen photo (pathRef), reused by every retry of that photo, so a late
// landing of an earlier attempt is found ("already exists") instead of leaving a second copy, and a duplicate row
// insert is turned away by the unique path index (23505 counts as saved).
import { createClient } from "@/lib/supabase/client";
import { compressImage } from "@/lib/carrier/image";

export type PodStep = { ok: true } | { ok: false; step: "upload" | "save" | "cancelled" };

export async function storePodPhoto(opts: {
  loadId: string;
  userId: string;
  file: File;
  pathRef: { current: string | null };
  attempt: { cancelled: boolean };
}): Promise<PodStep> {
  const { loadId, userId, file, pathRef, attempt } = opts;
  // A PDF the receiver handed over is stored as it is; a photo is shrunk to at most 1600 px (JPEG) first.
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const blob: Blob = isPdf ? file : await compressImage(file, 1600, 0.8);
  const path = (pathRef.current ??= `${loadId}/pod/${crypto.randomUUID()}.${isPdf ? "pdf" : "jpg"}`);
  const supabase = createClient();
  const up = await supabase.storage.from("documents").upload(path, blob, { contentType: isPdf ? "application/pdf" : "image/jpeg", upsert: false });
  const exists = up.error && (/already exists|duplicate/i.test(up.error.message) || String((up.error as { statusCode?: string }).statusCode) === "409");
  if (up.error && !exists) return { ok: false, step: "upload" };
  if (attempt.cancelled) return { ok: false, step: "cancelled" }; // the watchdog gave up on this attempt
  const ins = await supabase
    .from("load_documents")
    .insert({ load_id: loadId, kind: "pod", storage_path: path, uploaded_by: userId });
  if (ins.error && ins.error.code !== "23505") return { ok: false, step: "save" };
  return { ok: true };
}
