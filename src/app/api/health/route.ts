import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

// Public liveness check used by the keepalive workflow. Returns no data.
export async function GET() {
  try {
    const { error } = await createAdminClient()
      .from("customers")
      .select("id", { head: true })
      .limit(1);
    if (error) throw error;
    return NextResponse.json({ ok: true }, { status: 200, headers: HEADERS });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: HEADERS });
  }
}
