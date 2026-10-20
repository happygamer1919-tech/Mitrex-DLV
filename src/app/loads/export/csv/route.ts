import { getSessionProfile } from "@/lib/auth";
import { loadsCsv, text } from "@/lib/loads-csv";

export const dynamic = "force-dynamic";

// R46: Maria's export of her own loads. Customers only; the session client (RLS) returns only her customer's loads and
// the query is narrowed to that customer again. Same columns as R27, never a lane reference.
export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return text("Sign in required.", 401);
  if (profile.role !== "customer" || !profile.customer_id) return text("Customers only.", 403);
  return loadsCsv(request, { customerId: profile.customer_id, filePrefix: "my-loads" });
}
