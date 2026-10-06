"use client";

import { useEffect, useId, useRef, useState } from "react";
import { checkFile, formatBytes } from "@/lib/client/file-check";

type Props = {
  /** The chosen file. Controlled: the parent clears it (null) after a successful upload. */
  file: File | null;
  onFile: (file: File | null) => void;
  /** Accepted extensions without the dot, lower case. */
  exts: string[];
  maxBytes: number;
  typeError?: string;
  sizeError?: string;
  /** Short name of what is being added, used for the accessible name, e.g. "Bill of lading". */
  label: string;
  /** Offer the camera on phones (capture="environment"). */
  camera?: boolean;
  /** Driver (ink surface) screens: 48px minimum targets instead of 44px. */
  driver?: boolean;
  disabled?: boolean;
  hint?: string;
};

export function DropZone({ file, onFile, exts, maxBytes, typeError, sizeError, label, camera = false, driver = false, disabled = false, hint }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");
  const depth = useRef(0);
  const descId = useId();
  const errId = useId();
  const target = driver ? "min-h-[48px]" : "min-h-[44px]";

  // A file dropped slightly outside the zone must not make the browser navigate to it and lose the page.
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes("Files")) e.preventDefault();
    };
    document.addEventListener("dragover", stop);
    document.addEventListener("drop", stop);
    return () => {
      document.removeEventListener("dragover", stop);
      document.removeEventListener("drop", stop);
    };
  }, []);

  function take(f: File | undefined | null) {
    if (!f) return;
    const problem = checkFile(f, { exts, maxBytes, typeError, sizeError });
    if (problem) {
      setError(problem);
      onFile(null);
      return;
    }
    setError("");
    onFile(f);
  }

  function openPicker() {
    if (disabled) return;
    input.current?.click();
  }

  const accept = exts.map((e) => `.${e}`).join(",") + (camera ? ",image/*" : "");

  return (
    <div className="space-y-2" data-testid="dropzone-wrap">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={`${label}. Drop the file here, or tap to choose.`}
        aria-describedby={error ? errId : undefined}
        data-testid="dropzone"
        data-over={over ? "true" : "false"}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (disabled) return;
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = disabled ? "none" : "copy";
          if (!disabled) setOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          if (disabled) return;
          take(e.dataTransfer?.files?.[0]);
        }}
        className={`flex min-h-[96px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed px-4 py-4 text-center ${
          over ? "border-ink bg-mint" : "border-line bg-white"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span id={descId} className="text-[15px] font-medium text-ink">Drop the file here, or tap to choose</span>
        <span aria-hidden="true" className={`inline-flex ${target} items-center justify-center rounded-full bg-ink px-6 text-[15px] font-bold text-white`}>
          Choose file
        </span>
        {hint ? <span className="text-[13px] text-muted">{hint}</span> : null}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        data-testid="dropzone-input"
        accept={accept}
        capture={camera ? "environment" : undefined}
        disabled={disabled}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // choosing the same file again must fire change again
          take(f);
        }}
      />
      {error ? (
        <p id={errId} role="alert" data-testid="dropzone-error" className="rounded-[12px] bg-[#F7D9D9] px-4 py-3 text-[15px] text-[#7A1F1F]">{error}</p>
      ) : null}
      {file ? (
        <div data-testid="dropzone-file" className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-line bg-white px-3 py-2 text-ink">
          <span className="min-w-0 break-all text-[15px]">
            <span className="font-bold">{file.name}</span> <span className="text-muted">({formatBytes(file.size)})</span>
          </span>
          <button
            type="button"
            onClick={() => { setError(""); onFile(null); }}
            disabled={disabled}
            className={`inline-flex ${target} cursor-pointer items-center justify-center rounded-full border border-line px-4 text-[15px] font-bold disabled:opacity-50`}
          >
            Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}
