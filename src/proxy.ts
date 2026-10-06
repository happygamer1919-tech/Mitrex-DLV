import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { loginPathFor } from "@/lib/safe-next";

const PUBLIC = ["/login", "/auth/callback", "/manifest.webmanifest", "/sw.js", "/icons", "/logo.png", "/api/health"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(p + "/"));
  if (!user && !isPublic) {
    // A server action call cannot follow a redirect to an HTML page (the client would throw an opaque
    // error). Answer 401 text/plain (the exact type Next reads as an error message) with a marker body; the client sends the user to /login?next=<current page>.
    if (request.method === "POST" && request.headers.has("next-action")) {
      return new NextResponse("SESSION_EXPIRED", { status: 401, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }
    // Page visit: back to the original path and query after sign-in (validated, else role home).
    return NextResponse.redirect(new URL(loginPathFor(path + request.nextUrl.search), request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)"],
};
