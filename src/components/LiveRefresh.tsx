"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Re-renders the current server page when loads or load_events change (Supabase Realtime),
// with a 15 second polling fallback. RLS already limits which rows the user is sent.
export function LiveRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const supabase = createClient();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; router.refresh(); }, 300);
    };
    const channel = supabase
      .channel("live-loads")
      .on("postgres_changes", { event: "*", schema: "public", table: "loads" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "load_events" }, refresh)
      .subscribe();
    const timer = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, intervalMs);
    return () => {
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      supabase.removeChannel(channel);
    };
  }, [router, intervalMs]);
  return null;
}
