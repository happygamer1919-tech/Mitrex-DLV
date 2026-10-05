import { createClient } from "@supabase/supabase-js";

// Service role client. Server side only. Bypasses RLS: every caller must check the actor first.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
