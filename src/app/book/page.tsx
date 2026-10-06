import { Shell } from "@/components/Shell";
import { PageTitle } from "@/components/ui";
import { LoadForm } from "@/components/customer/LoadForm";
import { requireCustomer } from "@/lib/auth";
import {
  buildLastContacts, HISTORY_COLUMNS, HISTORY_LIMIT, parseFromParam, requestAgainValues, type HistoryRow,
} from "@/lib/customer/requestAgain";
import { EMPTY_LOAD_FORM, type LoadFormValues } from "@/lib/customer/validate";
import { todayEastern } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Load, Location } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function BookPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await searchParams;
  const profile = await requireCustomer();
  const supabase = await createClient();
  const { data } = await supabase.from("locations").select("*").eq("is_active", true).order("name");
  const locations = (data ?? []) as Location[];

  // Last contact per location: the customer's most recent 200 loads (session client, RLS), grouped in code.
  const { data: hist } = await supabase.from("loads").select(HISTORY_COLUMNS)
    .order("created_at", { ascending: false }).limit(HISTORY_LIMIT);
  const lastContacts = buildLastContacts((hist ?? []) as unknown as HistoryRow[]);

  // Request again: ?from=<load id> is untrusted. Anything but the customer's own delivered load opens an empty form.
  let initial: LoadFormValues = EMPTY_LOAD_FORM;
  let copiedFrom: string | null = null;
  const fromId = parseFromParam(from);
  if (fromId && profile.customer_id) {
    const { data: src } = await supabase.from("loads").select("*")
      .eq("id", fromId).eq("customer_id", profile.customer_id).eq("status", "delivered").maybeSingle();
    if (src) {
      const l = src as unknown as Load;
      const pickupOk = locations.some((x) => x.id === l.pickup_location_id && x.can_ship);
      const deliveryOk = locations.some((x) => x.id === l.delivery_location_id && x.can_receive);
      initial = requestAgainValues(l, { pickupOk, deliveryOk });
      copiedFrom = l.load_number;
    }
  }

  return (
    <Shell profile={profile}>
      <PageTitle>Book a load</PageTitle>
      <LoadForm
        key={copiedFrom ? fromId : "new"}
        mode="create" locations={locations} initial={initial} today={todayEastern()}
        lastContacts={lastContacts} copiedFrom={copiedFrom}
      />
    </Shell>
  );
}
