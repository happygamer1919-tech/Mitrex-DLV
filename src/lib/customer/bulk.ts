// Multi-truck booking helpers: quantity rules, row building and the single insert. Pure (no Next imports) and
// relative imports only, so the e2e specs can load this file directly.
import { toLoadRow, type LoadFormValues } from "./validate";

export const MAX_TRUCKS = 10;
export const MAX_LOADS_PER_WINDOW = 30; // per customer user, per RECENT_WINDOW_MINUTES (default, see docs/QUESTIONS.md)
export const RECENT_WINDOW_MINUTES = 10;

// Text from the form field. Digits only, whole number 1..MAX_TRUCKS. Returns the number or an error message.
export function parseQuantityText(text: string): { value: number } | { error: string } {
  const t = text.trim();
  if (t === "") return { error: "Enter how many trucks (1 to 10)." };
  if (!/^\d+$/.test(t)) return { error: "Trucks must be a whole number from 1 to 10." };
  const n = Number(t);
  if (n < 1 || n > MAX_TRUCKS) return { error: `Trucks must be from 1 to ${MAX_TRUCKS}.` };
  return { value: n };
}

// Server side: the action receives arbitrary input, only a real integer 1..MAX_TRUCKS passes.
export function validateQuantity(q: unknown): { value: number } | { error: string } {
  if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > MAX_TRUCKS) {
    return { error: `Trucks must be a whole number from 1 to ${MAX_TRUCKS}.` };
  }
  return { value: q };
}

// True when creating `n` more loads would pass the cap for the recent window.
export function exceedsRecentCap(recent: number, n: number, cap: number = MAX_LOADS_PER_WINDOW): boolean {
  return recent + n > cap;
}

// First line of every truck's notes when more than one truck is booked. User notes follow.
export function truckNotes(index: number, total: number, userNotes: string | null): string | null {
  if (total <= 1) return userNotes;
  const head = `Truck ${index + 1} of ${total}`;
  return userNotes ? `${head}\n${userNotes}` : head;
}

export type NewLoadRow = ReturnType<typeof toLoadRow> & {
  customer_id: string; created_by: string; status: "requested";
};

// One row per truck, identical values. customer_id and created_by come from the session profile, never the client.
export function buildTruckRows(
  values: LoadFormValues, moffett: boolean, quantity: number, customerId: string, createdBy: string,
): NewLoadRow[] {
  const base = toLoadRow(values, moffett);
  return Array.from({ length: quantity }, (_, i) => ({
    ...base,
    notes: truckNotes(i, quantity, base.notes),
    customer_id: customerId,
    created_by: createdBy,
    status: "requested" as const,
  }));
}

type InsertClient = {
  from(table: "loads"): {
    insert(rows: NewLoadRow[]): {
      select(cols: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
};

const num = (loadNumber: string) => Number(/(\d+)$/.exec(loadNumber)?.[1] ?? 0);

// ONE insert statement (all or nothing), ids read back with RETURNING, sorted by load number.
export async function insertTruckLoads(sb: InsertClient, rows: NewLoadRow[]):
  Promise<{ loads: { id: string; load_number: string }[] } | { error: string }> {
  const { data, error } = await sb.from("loads").insert(rows).select("id,load_number");
  if (error || !data || data.length !== rows.length) return { error: error?.message ?? "insert returned the wrong number of rows" };
  const loads = (data as { id: string; load_number: string }[]).slice().sort((a, b) => num(a.load_number) - num(b.load_number));
  return { loads };
}

// "MTX-0005 to MTX-0008" when consecutive, otherwise the numbers listed.
export function loadNumberSummary(numbers: string[]): string {
  if (numbers.length === 1) return numbers[0];
  const nums = numbers.map(num);
  const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  return consecutive ? `${numbers[0]} to ${numbers[numbers.length - 1]}` : numbers.join(", ");
}
