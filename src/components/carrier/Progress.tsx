import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import { PROGRESS_STEPS } from "@/lib/carrier/loads";

// Six segments, one per step. Done and current segments are neon. Sits on the ink surface.
export function Progress({ status }: { status: LoadStatus }) {
  const index = PROGRESS_STEPS.indexOf(status);
  const current = index < 0 ? 0 : index;
  return (
    <div aria-label={`Progress: ${STATUS_LABEL[status]}`}>
      <ol className="flex gap-1.5" aria-hidden>
        {PROGRESS_STEPS.map((s, i) => (
          <li
            key={s}
            className={`h-2 flex-1 rounded-full ${i <= current ? "bg-neon" : "bg-white/25"}`}
          />
        ))}
      </ol>
      <p className="mt-2 text-[15px] text-white">
        Step {current + 1} of {PROGRESS_STEPS.length}: <span className="font-bold">{STATUS_LABEL[PROGRESS_STEPS[current]]}</span>
      </p>
    </div>
  );
}
