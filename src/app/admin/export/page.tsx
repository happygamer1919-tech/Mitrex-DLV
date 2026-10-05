import { Shell } from "@/components/Shell";
import { PageTitle } from "@/components/ui";
import { ExportForm } from "@/components/admin/ExportForm";
import { requireStaff } from "@/lib/auth";
import { todayEastern } from "@/lib/format";
import { addDays } from "@/lib/admin/cal";

export const dynamic = "force-dynamic";

export default async function ExportPage() {
  const profile = await requireStaff();
  const today = todayEastern();
  return (
    <Shell profile={profile}>
      <PageTitle>Export loads</PageTitle>
      <div className="max-w-xl">
        <ExportForm defaultFrom={addDays(today, -30)} defaultTo={addDays(today, 30)} />
      </div>
    </Shell>
  );
}
