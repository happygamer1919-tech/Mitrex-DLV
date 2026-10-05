import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isCarrier, isStaff, type Profile, type Role } from "@/lib/types";

export async function getSessionProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("profiles")
    .select("id,email,full_name,role,customer_id,carrier_id")
    .eq("id", user.id)
    .maybeSingle();
  return (data as Profile | null) ?? null;
}

export function homeFor(role: Role): string {
  if (isStaff(role)) return "/admin";
  if (isCarrier(role)) return "/my-loads";
  return "/loads";
}

export async function requireProfile(allowed?: (r: Role) => boolean): Promise<Profile> {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (allowed && !allowed(profile.role)) redirect(homeFor(profile.role));
  return profile;
}

export const requireStaff = () => requireProfile(isStaff);
export const requireAdmin = () => requireProfile((r) => r === "staff_admin");
export const requireCustomer = () => requireProfile((r) => r === "customer");
export const requireCarrier = () => requireProfile(isCarrier);
export const requireOwner = () => requireProfile((r) => r === "carrier_owner");
