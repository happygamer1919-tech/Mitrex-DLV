import { Shell } from "@/components/Shell";
import { PageTitle } from "@/components/ui";
import { LoadForm } from "@/components/customer/LoadForm";
import { requireCustomer } from "@/lib/auth";
import { EMPTY_LOAD_FORM } from "@/lib/customer/validate";
import { todayEastern } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function BookPage() {
  const profile = await requireCustomer();
  const supabase = await createClient();
  const { data } = await supabase.from("locations").select("*").eq("is_active", true).order("name");
  return (
    <Shell profile={profile}>
      <PageTitle>Book a load</PageTitle>
      <LoadForm mode="create" locations={(data ?? []) as Location[]} initial={EMPTY_LOAD_FORM} today={todayEastern()} />
    </Shell>
  );
}
