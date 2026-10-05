export const USERS = {
  admin: { email: "admin@e2e.test", role: "staff_admin" },
  maria: { email: "maria@e2e.test", role: "customer" },
  carrierA: { email: "owner-a@e2e.test", role: "carrier_owner" },
  carrierB: { email: "owner-b@e2e.test", role: "carrier_owner" },
} as const;
export type Who = keyof typeof USERS;
export const CARRIER_A = "E2E Carrier A";
export const CARRIER_B = "E2E Carrier B";
export const stateFile = (who: Who) => `e2e/.auth/${who}.json`;
