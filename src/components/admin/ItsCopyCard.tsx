import { CopyButton } from "@/components/admin/CopyButton";
import { LinkButton } from "@/components/ui";
import { addLanePath, NO_REFERENCE_TEXT, type LaneReference, type Scenario } from "@/lib/admin/lane-reference";

// Staff only. Rendered by /admin/loads/[id] above the booking card. `ref` is null when the scenario has no row,
// and `failed` when the lookup itself failed (never shown as "no reference").
export function ItsCopyCard({ reference, failed, scenario, scenarioText }: {
  reference: LaneReference | null; failed: boolean; scenario: Scenario; scenarioText: string;
}) {
  if (failed) {
    return (
      <div className="rounded-[16px] border-2 border-amber bg-card p-4" data-testid="its-copy-card">
        <h2 className="text-[20px] font-bold">ITS load to copy</h2>
        <p className="mt-2 text-[15px]">The lane reference could not be loaded. Reload the page, or check the Lanes page.</p>
      </div>
    );
  }
  if (!reference) {
    return (
      <div className="rounded-[16px] border-2 border-amber bg-[#FFF3E3] p-4" data-testid="its-copy-card">
        <h2 className="text-[20px] font-bold">ITS load to copy</h2>
        <p data-testid="its-copy-none" className="mt-2 text-[18px] font-bold">{NO_REFERENCE_TEXT}</p>
        <p data-testid="its-copy-scenario" className="mt-1 text-[15px]">{scenarioText}</p>
        <div className="mt-3">
          <LinkButton href={addLanePath(scenario)} variant="primary">Add it</LinkButton>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-[16px] border-2 border-neon bg-card p-4" data-testid="its-copy-card">
      <h2 className="text-[20px] font-bold">ITS load to copy</h2>
      <p data-testid="its-copy-number" className="mt-1 text-[48px] font-bold leading-none tracking-tight">{reference.number}</p>
      <p data-testid="its-copy-scenario" className="mt-2 text-[15px]">{reference.laneLabel}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <CopyButton value={reference.number} />
      </div>
    </div>
  );
}
