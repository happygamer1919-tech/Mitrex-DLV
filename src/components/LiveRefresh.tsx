"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Re-renders the current server page when loads or load_events change (Supabase Realtime),
// with a 15 second polling fallback. RLS limits which rows the user is sent, but only if the
// websocket carries the user's JWT: without it Realtime evaluates RLS as anon and every event
// arrives as "Error 401: Unauthorized" with an empty record. So the token is set before subscribing.
// DLV-043 CAR-02: no refresh while the browser is offline. A failed refresh makes Next fall back to a full browser
// navigation, and Chrome then showed its own offline page in place of the driver's load (an open POD, photo or ETA was
// lost). One refresh runs when the connection comes back, and one when the page becomes visible again (CAR-07: the
// signed links of a page left in the background expire).
// The e2e specs may shorten the interval with window.__DLV_LIVE_MS (set before the page loads, 1000 ms at least).
function pollMs(fallback: number): number {
  const w = typeof window !== "undefined" ? (window as unknown as { __DLV_LIVE_MS?: unknown }).__DLV_LIVE_MS : undefined;
  return typeof w === "number" && Number.isFinite(w) && w >= 1000 ? w : fallback;
}
const online = () => typeof navigator === "undefined" || navigator.onLine !== false;

export function LiveRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const supabase = createClient();
    let pending: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const refreshNow = () => { if (online()) router.refresh(); };
    const refresh = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; refreshNow(); }, 300);
    };

    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session?.access_token) await supabase.realtime.setAuth(data.session.access_token);
      if (cancelled) return;
      channel = supabase
        .channel("live-loads")
        .on("postgres_changes", { event: "*", schema: "public", table: "loads" }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "load_events" }, refresh)
        .subscribe();
    })();

    // Keep the websocket authenticated across token refreshes.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) void supabase.realtime.setAuth(session.access_token);
    });
    const timer = setInterval(() => { if (document.visibilityState === "visible") refreshNow(); }, pollMs(intervalMs));
    const onOnline = () => refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      sub.subscription.unsubscribe();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [router, intervalMs]);
  return null;
}
