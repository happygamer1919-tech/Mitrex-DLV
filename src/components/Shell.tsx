import { AppHeader } from "@/components/AppHeader";
import type { Profile } from "@/lib/types";

// Page chrome. Driver pages render on ink, everyone else on mint.
export function Shell({ profile, children, driver = false }: { profile: Profile; children: React.ReactNode; driver?: boolean }) {
  return (
    <div className={driver ? "driver-surface min-h-screen bg-ink text-white" : "min-h-screen"}>
      <AppHeader profile={profile} driver={driver} />
      <main className="mx-auto max-w-6xl px-4 py-5">{children}</main>
    </div>
  );
}
