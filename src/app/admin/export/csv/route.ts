import { getSessionProfile } from "@/lib/auth";
import { isStaff } from "@/lib/types";
import { loadsCsv, text } from "@/lib/loads-csv";

export const dynamic = "force-dynamic";

// R27: staff export of every load (the shared builder is src/lib/loads-csv.ts).
export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return text("Sign in required.", 401);
  if (!isStaff(profile.role)) return text("Staff only.", 403);
  return loadsCsv(request, { filePrefix: "dlv-loads" });
}
