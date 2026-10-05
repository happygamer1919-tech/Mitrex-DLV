"use server";

import { revalidatePath } from "next/cache";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { easternLocalToIso } from "@/lib/format";
import { isCarrier, type LoadStatus } from "@/lib/types";
import { NEXT_STATUS, UUID_RE } from "@/lib/carrier/loads";

export type ActionResult = { ok: true } | { ok: false; error: string };

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function parseEta(local: string | null | undefined): string | null {
  if (!local || !LOCAL_RE.test(local)) return null;
  const iso = easternLocalToIso(local);
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

async function carrierOnly(loadId: string): Promise<string | null> {
  if (!UUID_RE.test(loadId)) return "That load could not be found.";
  const profile = await getSessionProfile();
  if (!profile || !isCarrier(profile.role)) return "You are not allowed to do that.";
  return null;
}

function refresh(loadId: string) {
  revalidatePath("/my-loads");
  revalidatePath(`/my-loads/${loadId}`);
}

// Moves a load to its next step. The database enforces the order, the carrier and the rules.
export async function advanceLoad(loadId: string, status: LoadStatus, etaLocal?: string): Promise<ActionResult> {
  const denied = await carrierOnly(loadId);
  if (denied) return { ok: false, error: denied };

  const allowed = Object.values(NEXT_STATUS);
  if (!allowed.includes(status)) return { ok: false, error: "That step is not available." };

  let eta: string | null = null;
  if (status === "enroute") {
    eta = parseEta(etaLocal);
    if (!eta) return { ok: false, error: "Enter the delivery ETA (Eastern time)." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_load_status", {
    p_load: loadId,
    p_status: status,
    p_eta: eta,
    p_note: null,
  });
  if (error) return { ok: false, error: error.message };
  refresh(loadId);
  return { ok: true };
}

export async function updateEta(loadId: string, etaLocal: string): Promise<ActionResult> {
  const denied = await carrierOnly(loadId);
  if (denied) return { ok: false, error: denied };
  const eta = parseEta(etaLocal);
  if (!eta) return { ok: false, error: "Enter the delivery ETA (Eastern time)." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_load_eta", { p_load: loadId, p_eta: eta, p_note: null });
  if (error) return { ok: false, error: error.message };
  refresh(loadId);
  return { ok: true };
}
