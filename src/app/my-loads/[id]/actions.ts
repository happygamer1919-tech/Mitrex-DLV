"use server";

import { revalidatePath } from "next/cache";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { easternLocalToIso } from "@/lib/format";
import { isCarrier, type LoadStatus } from "@/lib/types";
import { NEXT_STATUS, UUID_RE } from "@/lib/carrier/loads";

// code "auth": the session is gone (client goes to /login?next=...). code "stale": the load is no longer
// in the status the client acted on (client refreshes).
export type ActionResult = { ok: true } | { ok: false; error: string; code?: "auth" | "stale" };

const STALE_MESSAGE = "This load was already updated. Refreshing now."; // not exported: "use server" files export functions only

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function parseEta(local: string | null | undefined): string | null {
  if (!local || !LOCAL_RE.test(local)) return null;
  const iso = easternLocalToIso(local);
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

async function carrierOnly(loadId: string): Promise<ActionResult | null> {
  if (!UUID_RE.test(loadId)) return { ok: false, error: "That load could not be found." };
  const profile = await getSessionProfile();
  if (!profile) return { ok: false, error: "Your session has expired. Sending you to sign in.", code: "auth" };
  if (!isCarrier(profile.role)) return { ok: false, error: "You are not allowed to do that." };
  return null;
}

function refresh(loadId: string) {
  revalidatePath("/my-loads");
  revalidatePath(`/my-loads/${loadId}`);
}

// Moves a load to its next step. The database enforces the order, the carrier and the rules.
// expectedFrom is the status the client believed the load was in. If the load has moved on (a double
// tap, a second device, a replayed request) nothing is written and the client is told to refresh.
export async function advanceLoad(
  loadId: string, status: LoadStatus, expectedFrom: LoadStatus, etaLocal?: string,
): Promise<ActionResult> {
  const denied = await carrierOnly(loadId);
  if (denied) return denied;

  if (NEXT_STATUS[expectedFrom] !== status) return { ok: false, error: "That step is not available." };

  let eta: string | null = null;
  if (status === "enroute") {
    eta = parseEta(etaLocal);
    if (!eta) return { ok: false, error: "Enter the delivery ETA (Eastern time)." };
  }

  const supabase = await createClient();
  const current = await supabase.from("loads").select("status").eq("id", loadId).maybeSingle();
  if (current.error) return { ok: false, error: current.error.message };
  if (!current.data) return { ok: false, error: "That load could not be found." };
  if (current.data.status !== expectedFrom) {
    refresh(loadId);
    return { ok: false, error: STALE_MESSAGE, code: "stale" };
  }
  const { error } = await supabase.rpc("set_load_status", {
    p_load: loadId,
    p_status: status,
    p_eta: eta,
    p_note: null,
  });
  if (error) {
    // A concurrent request can win between the read above and the write. The database refuses the
    // loser (it only allows one step forward); report that as stale, not as a raw database message.
    const again = await supabase.from("loads").select("status").eq("id", loadId).maybeSingle();
    if (again.data && again.data.status !== expectedFrom) {
      refresh(loadId);
      return { ok: false, error: STALE_MESSAGE, code: "stale" };
    }
    return { ok: false, error: error.message };
  }
  refresh(loadId);
  return { ok: true };
}

export async function updateEta(loadId: string, etaLocal: string): Promise<ActionResult> {
  const denied = await carrierOnly(loadId);
  if (denied) return denied;
  const eta = parseEta(etaLocal);
  if (!eta) return { ok: false, error: "Enter the delivery ETA (Eastern time)." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_load_eta", { p_load: loadId, p_eta: eta, p_note: null });
  if (error) return { ok: false, error: error.message };
  refresh(loadId);
  return { ok: true };
}
