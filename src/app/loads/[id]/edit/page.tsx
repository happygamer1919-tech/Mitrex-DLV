import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { PageTitle } from "@/components/ui";
import { LoadForm } from "@/components/customer/LoadForm";
import { requireCustomer } from "@/lib/auth";
import { loadToFormValues } from "@/lib/customer/queries";
import { todayEastern } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Load, Location } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EditLoadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireCustomer();
  const supabase = await createClient();
  const { data: load } = await supabase.from("loads").select("*").eq("id", id).maybeSingle();
  if (!load) notFound();
  const l = load as Load;
  if (l.status !== "requested") redirect(`/loads/${id}`);
  const { data: locs } = await supabase.from("locations").select("*").eq("is_active", true).order("name");
  return (
    <Shell profile={profile}>
      <PageTitle>Edit {l.load_number}</PageTitle>
      <LoadForm mode="edit" loadId={id} locations={(locs ?? []) as Location[]}
        initial={loadToFormValues(l)} today={todayEastern()} />
    </Shell>
  );
}
