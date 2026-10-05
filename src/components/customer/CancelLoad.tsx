"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Notice } from "@/components/ui";
import { cancelLoad } from "@/lib/customer/actions";

export function CancelLoad({ loadId, loadNumber }: { loadId: string; loadNumber: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await cancelLoad(loadId);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  if (!confirming) {
    return <Button variant="danger" type="button" onClick={() => setConfirming(true)}>Cancel load</Button>;
  }
  return (
    <div className="w-full space-y-3 rounded-[16px] border border-line bg-white p-4">
      <p className="text-[15px] font-medium">Cancel {loadNumber}? This cannot be undone.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex flex-wrap gap-3">
        <Button variant="danger" type="button" disabled={pending} onClick={run}>
          {pending ? "Cancelling..." : "Yes, cancel this load"}
        </Button>
        <Button variant="ghost" type="button" disabled={pending} onClick={() => setConfirming(false)}>
          Keep load
        </Button>
      </div>
    </div>
  );
}
