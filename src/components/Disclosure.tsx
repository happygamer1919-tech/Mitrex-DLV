import type { ReactNode } from "react";

// R46 compact views: one collapsible section. A native details/summary, so it opens and closes without JavaScript,
// is announced as expanded or collapsed by screen readers and keeps its state across the 15 second live refresh
// (React only touches `open` when the prop itself changes). The summary is a 44px target with the global focus ring.
// `openLabel` replaces the closed label while open ("Show all 12 events" becomes "Show fewer events").
export function Disclosure({
  summary, openLabel, children, open = false, testid, className = "", summaryClassName = "", driver = false,
}: {
  summary: ReactNode; openLabel?: ReactNode; children: ReactNode; open?: boolean; testid?: string;
  className?: string; summaryClassName?: string; driver?: boolean;
}) {
  return (
    <details open={open} data-testid={testid} className={className}>
      <summary className={`disclosure flex ${driver ? "min-h-[48px]" : "min-h-[44px]"} cursor-pointer items-center gap-2 rounded-[12px] ${summaryClassName}`}>
        <span aria-hidden="true" className="disclosure-chevron inline-block shrink-0 transition-transform">
          <svg width="14" height="14" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        {openLabel ? (
          <>
            <span className="disclosure-when-closed">{summary}</span>
            <span className="disclosure-when-open">{openLabel}</span>
          </>
        ) : summary}
      </summary>
      {children}
    </details>
  );
}
