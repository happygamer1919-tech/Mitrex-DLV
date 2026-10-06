"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID, plainError, str } from "./errors";
import type { ActionState } from "./state";

const ROLES = ["staff_admin", "staff_csr", "customer", "carrier_owner", "carrier_driver"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Finds an existing auth user by email (used when createUser reports a duplicate).
async function findAuthUserId(admin: ReturnType<typeof createAdminClient>, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

export async function inviteUser(_prev: ActionState, fd: FormData): Promise<ActionState> {
  // Role check first: the service role client below bypasses RLS.
  await requireAdmin();
  const email = str(fd, "email").toLowerCase();
  const fullName = str(fd, "full_name");
  const role = str(fd, "role") as (typeof ROLES)[number];
  const customerId = str(fd, "customer_id");
  const carrierId = str(fd, "carrier_id");

  if (!EMAIL.test(email)) return { error: "Enter a valid email address." };
  if (!fullName) return { error: "Full name is required." };
  if (!ROLES.includes(role)) return { error: "Choose a role." };
  if (role === "customer" && !UUID.test(customerId)) return { error: "Choose a customer for this user." };
  if ((role === "carrier_owner" || role === "carrier_driver") && !UUID.test(carrierId)) {
    return { error: "Choose a carrier for this user." };
  }

  const admin = createAdminClient();
  const refusal = "This email cannot be added. Use a different email address.";
  // Scope consistency is checked against the database, never trusted from the form.
  if (role === "customer") {
    const { data: c } = await admin.from("customers").select("id").eq("id", customerId).maybeSingle();
    if (!c) return { error: "That customer does not exist." };
  }
  if (role === "carrier_owner" || role === "carrier_driver") {
    const { data: k } = await admin.from("carriers").select("id,is_active").eq("id", carrierId).maybeSingle();
    if (!k || !k.is_active) return { error: "Choose an active carrier." };
  }
  const { data: dup } = await admin.from("profiles").select("id").ilike("email", email.replace(/[\\%_]/g, "\\$&")).maybeSingle();
  if (dup) return { error: refusal };

  let userId: string | null = null;
  let created = false;
  const res = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (res.error || !res.data.user) {
    // An auth account without a profile (earlier failed invite) can be adopted.
    userId = await findAuthUserId(admin, email);
    if (!userId) return { error: "Could not create the user. Try again." };
  } else {
    userId = res.data.user.id;
    created = true;
  }

  const { error } = await admin.from("profiles").insert({
    id: userId,
    email,
    full_name: fullName,
    role,
    customer_id: role === "customer" ? customerId : null,
    carrier_id: role === "carrier_owner" || role === "carrier_driver" ? carrierId : null,
  });
  if (error) {
    if (created) await admin.auth.admin.deleteUser(userId);
    return { error: error.code === "23505" ? refusal : "Could not save the user profile. Nothing was created." };
  }
  revalidatePath("/admin/users");
  return { ok: `User created. ${email} can now sign in from the login page.` };
}

export async function removeUser(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const me = await requireAdmin();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "User not found." };
  if (id === me.id) return { error: "You cannot remove your own account." };

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("role,is_active").eq("id", id).maybeSingle();
  if (target?.role === "staff_admin" && target.is_active && (await activeAdminCount(admin, id)) === 0) {
    return { error: "You cannot remove the last active staff admin." };
  }
  // Deleting the auth user cascades to the profile. It fails if the user created loads.
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) {
    // Auth hides the database message, so re-check: still an active admin with no other active admin means the trigger fired.
    if (target?.role === "staff_admin" && target.is_active && (await activeAdminCount(admin, id)) === 0) {
      return { error: LAST_ADMIN_MSG };
    }
    return { error: `Could not remove this user (${error.message}). A user who created loads or requests cannot be deleted.` };
  }
  // Orphan safety: remove a leftover profile row if the cascade did not run.
  await admin.from("profiles").delete().eq("id", id);
  revalidatePath("/admin/users");
  return { ok: "User removed." };
}

const BAN_FOREVER = "876000h";
const LAST_ADMIN_MSG = "You cannot deactivate or remove the last active staff admin.";

// The database trigger (migration 0008) refuses to leave zero active staff admins. It can fire before
// the app check above when two admins act at the same moment, so map its error to the same plain message.
function isLastAdminError(error: { message?: string; code?: string } | null | undefined): boolean {
  return !!error && error.code === "23514" && /active staff admin/i.test(error.message ?? "");
}

async function activeAdminCount(admin: ReturnType<typeof createAdminClient>, excludeId: string): Promise<number> {
  const { count } = await admin.from("profiles").select("id", { count: "exact", head: true })
    .eq("role", "staff_admin").eq("is_active", true).neq("id", excludeId);
  return count ?? 0;
}

// Deactivate (active=false) or reactivate (active=true). Two layers: the profile flag
// (denies every policy and function) and an auth ban (no new code, link or refresh).
async function setActive(fd: FormData, active: boolean): Promise<ActionState> {
  const me = await requireAdmin();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "User not found." };
  if (!active && id === me.id) return { error: "You cannot deactivate your own account." };

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("id,role,is_active").eq("id", id).maybeSingle();
  if (!target) return { error: "User not found." };
  if (target.is_active === active) return { ok: active ? "User is already active." : "User is already inactive." };
  if (!active && target.role === "staff_admin" && (await activeAdminCount(admin, id)) === 0) {
    return { error: "You cannot deactivate the last active staff admin." };
  }

  if (active) {
    // Unban first so a failure leaves the user inactive rather than active but banned.
    const { error: banErr } = await admin.auth.admin.updateUserById(id, { ban_duration: "none" });
    if (banErr) return { error: "Could not reactivate this user. Nothing was changed." };
    const { error } = await admin.from("profiles").update({ is_active: true }).eq("id", id);
    if (error) return { error: "Could not reactivate this user. Try again." };
    revalidatePath("/admin/users");
    return { ok: "User reactivated. They can sign in again." };
  }

  const { error } = await admin.from("profiles").update({ is_active: false }).eq("id", id);
  if (isLastAdminError(error)) return { error: LAST_ADMIN_MSG };
  if (error) return { error: "Could not deactivate this user. Nothing was changed." };
  const { error: banErr } = await admin.auth.admin.updateUserById(id, { ban_duration: BAN_FOREVER });
  if (banErr) {
    await admin.from("profiles").update({ is_active: true }).eq("id", id);
    return { error: "Could not deactivate this user. Nothing was changed." };
  }
  revalidatePath("/admin/users");
  return { ok: "User deactivated. They can no longer sign in." };
}

export async function deactivateUser(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return setActive(fd, false);
}

export async function reactivateUser(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return setActive(fd, true);
}
