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
  const { data: dup } = await admin.from("profiles").select("id").ilike("email", email.replace(/[\\%_]/g, "\\$&")).maybeSingle();
  if (dup) return { error: "A user with that email already exists." };

  let userId: string | null = null;
  let created = false;
  const res = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (res.error || !res.data.user) {
    // An auth account without a profile (earlier failed invite) can be adopted.
    userId = await findAuthUserId(admin, email);
    if (!userId) return { error: plainError(res.error, "Could not create the user.") };
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
    return { error: plainError(error, "Could not save the user profile.") };
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
  // Deleting the auth user cascades to the profile. It fails if the user created loads.
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) {
    return { error: `Could not remove this user (${error.message}). A user who created loads or requests cannot be deleted.` };
  }
  // Orphan safety: remove a leftover profile row if the cascade did not run.
  await admin.from("profiles").delete().eq("id", id);
  revalidatePath("/admin/users");
  return { ok: "User removed." };
}
