import Link from "next/link";
import { isCarrier, isStaff, type Profile } from "@/lib/types";
import { homeFor } from "@/lib/auth";

type NavItem = { href: string; label: string };

function navFor(p: Profile): NavItem[] {
  if (isStaff(p.role)) {
    const items: NavItem[] = [
      { href: "/admin", label: "Board" },
      { href: "/admin/calendar", label: "Calendar" },
      { href: "/admin/locations", label: "Locations" },
      { href: "/admin/lanes", label: "Lanes" },
      { href: "/admin/requests", label: "Requests" },
      { href: "/admin/rates", label: "Rate requests" },
      { href: "/admin/export", label: "Export" },
    ];
    if (p.role === "staff_admin") {
      items.push({ href: "/admin/carriers", label: "Carriers" }, { href: "/admin/users", label: "Users" });
    }
    return items;
  }
  if (isCarrier(p.role)) {
    const items: NavItem[] = [{ href: "/my-loads", label: "My loads" }];
    if (p.role === "carrier_owner") items.push({ href: "/team", label: "Team" });
    return items;
  }
  return [
    { href: "/loads", label: "Loads" },
    { href: "/book", label: "Book a load" },
    { href: "/rates", label: "Rates" },
    { href: "/locations", label: "Locations" },
  ];
}

export function AppHeader({ profile, driver = false }: { profile: Profile; driver?: boolean }) {
  const nav = navFor(profile);
  const h = driver ? "min-h-[48px]" : "min-h-[44px]";
  return (
    <header className="bg-ink text-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href={homeFor(profile.role)} className={`flex items-center gap-2 ${h}`}>
          <span className="text-[22px] font-bold tracking-tight">DLV</span>
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-neon" />
          <span className="text-[13px] text-white/80">Mitrex shipping portal</span>
        </Link>
        <nav aria-label="Main" className="order-3 -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto px-4 pb-1 md:order-none md:mx-0 md:w-auto md:flex-1 md:overflow-visible md:px-0 md:pb-0">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={`inline-flex ${h} shrink-0 items-center whitespace-nowrap rounded-full px-3 text-[15px] hover:bg-white/10`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <form action="/auth/signout" method="post" className="ml-auto md:ml-0">
          <button className={`inline-flex ${h} items-center rounded-full border border-white/30 px-4 text-[14px]`}>
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
