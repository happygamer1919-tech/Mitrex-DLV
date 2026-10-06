"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Re-renders the current server page when loads or load_events change (Supabase Realtime),
// with a 15 second polling fallback. RLS limits which rows the user is sent, but only if the
// websocket carries the user's JWT: without it Realtime evaluates RLS as anon and every event
// arrives as "Error 401: Unauthorized" with an empty record. So the token is set before subscribing.
export function LiveRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const supabase = createClient();
    let pending: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const refresh = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; router.refresh(); }, 300);
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
    const timer = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      sub.subscription.unsubscribe();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [router, intervalMs]);
  return null;
}
