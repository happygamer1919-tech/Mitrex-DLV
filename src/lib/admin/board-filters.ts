import {
  applyFilters as applyShared, parseFilters as parseShared,
  type LoadFilters, type SortKey as SharedSortKey,
} from "@/lib/load-filters";
import type { BoardLoad } from "@/lib/admin/queries";

// Board filters and sorting (R42). The logic lives in the shared module src/lib/load-filters.ts (also used by Maria's
// /loads, R46); this file keeps the staff names and the staff scope.

export {
  STATUSES, SIZES, WHEN_VALUES, SORT_KEYS, easternToday, isFiltered, toQuery, matches, sortLoads,
} from "@/lib/load-filters";
export type { When, View } from "@/lib/load-filters";

export type BoardFilters = LoadFilters;
export type SortKey = SharedSortKey;

type Raw = Record<string, string | string[] | undefined>;

export function parseFilters(raw: Raw): BoardFilters {
  return parseShared(raw, "staff");
}

export function applyFilters(loads: BoardLoad[], f: BoardFilters, today: string): BoardLoad[] {
  return applyShared(loads, f, today);
}
