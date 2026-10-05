import { Shell } from "@/components/Shell";
import { Notice, PageTitle } from "@/components/ui";
import { TeamManager, type Member } from "@/components/carrier/TeamManager";
import { requireOwner } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const profile = await requireOwner();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,full_name,role,created_at")
    .eq("carrier_id", profile.carrier_id!)
    .order("created_at", { ascending: true });

  const members: Member[] = (data ?? [])
    .map((m) => ({
      id: m.id as string,
      email: m.email as string,
      full_name: (m.full_name as string | null) ?? null,
      role: m.role as string,
      isSelf: m.id === profile.id,
    }))
    .sort((a, b) => Number(b.role === "carrier_owner") - Number(a.role === "carrier_owner"));

  return (
    <Shell profile={profile} driver>
      <div className="mx-auto max-w-2xl">
        <PageTitle>Team</PageTitle>
        {error ? <div className="mb-4"><Notice tone="error">Could not load your team. Try again in a moment.</Notice></div> : null}
        <TeamManager members={members} />
      </div>
    </Shell>
  );
}
