"use client";
import { useState } from "react";
import { Button } from "@/components/ui";

// Copies a value with the clipboard API and falls back to a hidden textarea and execCommand where the API is
// missing or refused (older browsers, an insecure context). The result is announced to screen readers.
export function CopyButton({ value }: { value: string }) {
  const [message, setMessage] = useState("");

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    setMessage(ok ? `Copied ${value}` : "Copy did not work. Select the number and copy it by hand.");
  }

  return (
    <>
      <Button type="button" variant="dark" onClick={copy} data-testid="its-copy-button">Copy</Button>
      <span role="status" aria-live="polite" data-testid="its-copy-status" className="text-[15px] font-medium">{message}</span>
    </>
  );
}
