"use server";

import { revalidatePath } from "next/cache";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/carrier/loads";
import type { Profile } from "@/lib/types";

export type TeamResult = { ok: true; message: string } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Server side owner check. The carrier id always comes from the caller's own profile.
async function ownerProfile(): Promise<Profile | null> {
  const p = await getSessionProfile();
  if (!p || p.role !== "carrier_owner" || !p.carrier_id) return null;
  return p;
}

export async function addDriver(emailInput: string, nameInput: string): Promise<TeamResult> {
  const owner = await ownerProfile();
  if (!owner || !owner.carrier_id) return { ok: false, error: "Only the carrier owner can add drivers." };

  const email = String(emailInput ?? "").trim().toLowerCase();
  const fullName = String(nameInput ?? "").trim();
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: "Enter a valid email address." };
  if (fullName.length > 100) return { ok: false, error: "The name is too long (100 characters at most)." };

  // Already on this team? The owner can read the team through RLS, so saying so leaks nothing.
  const supabase = await createClient();
  const { data: team } = await supabase.from("profiles").select("email").eq("carrier_id", owner.carrier_id);
  if ((team ?? []).some((m) => String(m.email).toLowerCase() === email)) {
    return { ok: false, error: "That person is already on your team." };
  }

  const refusal = "This email cannot be added. Use a different email address or contact dispatch.";
  const admin = createAdminClient();
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });
  if (created.error || !created.data.user) return { ok: false, error: refusal };

  const userId = created.data.user.id;
  const { error: insertError } = await admin.from("profiles").insert({
    id: userId,
    email,
    full_name: fullName || null,
    role: "carrier_driver",
    carrier_id: owner.carrier_id,
  });
  if (insertError) {
    await admin.auth.admin.deleteUser(userId); // roll back so no orphan login remains
    return { ok: false, error: refusal };
  }

  revalidatePath("/team");
  return { ok: true, message: `${fullName || email} was added. They can sign in with that email using the one-time link on the login page.` };
}

export async function removeDriver(profileId: string): Promise<TeamResult> {
  const owner = await ownerProfile();
  if (!owner || !owner.carrier_id) return { ok: false, error: "Only the carrier owner can remove drivers." };
  if (!UUID_RE.test(profileId)) return { ok: false, error: "That person could not be found." };
  if (profileId === owner.id) return { ok: false, error: "You cannot remove yourself." };

  const admin = createAdminClient();
  const { data: target } = await admin
    .from("profiles")
    .select("id,role,carrier_id,full_name,email")
    .eq("id", profileId)
    .maybeSingle();
  if (!target || target.role !== "carrier_driver" || target.carrier_id !== owner.carrier_id) {
    return { ok: false, error: "That person could not be found on your team." };
  }

  // Deleting the auth user cascades to the profile. It fails when the driver already has load history.
  const { error } = await admin.auth.admin.deleteUser(profileId);
  if (error) {
    return {
      ok: false,
      error: "This driver has activity on loads, so the account cannot be deleted. Ask dispatch to deactivate it.",
    };
  }
  revalidatePath("/team");
  return { ok: true, message: `${target.full_name || target.email} was removed.` };
}
