import Link from "next/link";
import { Shell } from "@/components/Shell";
import { PageTitle } from "@/components/ui";
import { ExportForm } from "@/components/admin/ExportForm";
import { requireCustomer } from "@/lib/auth";
import { todayEastern } from "@/lib/format";
import { addDays } from "@/lib/admin/cal";

export const dynamic = "force-dynamic";

// R46: Maria exports her own loads (date range and status, the columns of R27). The file comes from /loads/export/csv.
export default async function CustomerExportPage() {
  const profile = await requireCustomer();
  const today = todayEastern();
  return (
    <Shell profile={profile}>
      <Link href="/loads" className="mb-2 inline-flex min-h-[44px] items-center text-[15px] underline">All loads</Link>
      <PageTitle>Export my loads</PageTitle>
      <p className="mb-4 max-w-xl text-[15px] text-muted">A spreadsheet (CSV) of your loads. The load_number column holds the load number, or the request number while a load has none yet.</p>
      <div className="max-w-xl">
        <ExportForm defaultFrom={addDays(today, -30)} defaultTo={addDays(today, 30)} action="/loads/export/csv" />
      </div>
    </Shell>
  );
}
