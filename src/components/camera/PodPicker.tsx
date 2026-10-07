"use client";

// POD capture (DLV-032): the in-app camera is the primary way. A small secondary "Choose a file instead" opens the
// ordinary file area, kept for a PDF POD the receiver handed over. The POD stays OPTIONAL: nothing here is a gate.
import { useEffect, useState } from "react";
import { CameraCapture } from "@/components/camera/CameraCapture";
import { DropZone } from "@/components/DropZone";

export const POD_EXTS = ["jpg", "jpeg", "png", "webp", "heic", "pdf"];
export const POD_MAX_BYTES = 15 * 1024 * 1024;

type Mode = "idle" | "camera" | "file";

const BIG = "inline-flex min-h-[56px] w-full cursor-pointer items-center justify-center rounded-full bg-ink px-6 text-[18px] font-bold text-white disabled:opacity-50";
const LINK = "inline-flex min-h-[48px] cursor-pointer items-center justify-center self-start rounded-full px-3 text-[15px] font-medium text-ink underline disabled:opacity-50";

export function PodPicker({
  file, onFile, disabled = false, label,
}: { file: File | null; onFile: (f: File | null) => void; disabled?: boolean; label: string }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const isImage = Boolean(file && file.type.startsWith("image/"));

  useEffect(() => {
    if (!file || !isImage) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  if (mode === "camera") {
    return (
      <CameraCapture
        subject="POD photo"
        useLabel="Use this POD photo"
        busy={disabled}
        onUse={(c) => { onFile(new File([c.blob], "pod.jpg", { type: "image/jpeg" })); setMode("idle"); }}
        onCancel={() => setMode("idle")}
      />
    );
  }

  if (mode === "file") {
    return (
      <div className="space-y-2">
        <DropZone
          file={file}
          onFile={onFile}
          exts={POD_EXTS}
          maxBytes={POD_MAX_BYTES}
          typeError="Use a photo or a PDF (jpg, png, webp, heic or pdf)."
          sizeError="The file is larger than 15 MB."
          label={label}
          driver
          disabled={disabled}
        />
        <button type="button" className={LINK} disabled={disabled} onClick={() => { onFile(null); setMode("camera"); }} data-testid="pod-use-camera">
          Use the camera instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="pod-picker">
      {file ? (
        <div className="space-y-2" data-testid="pod-ready">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="POD photo, preview" className="max-h-56 w-full rounded-[12px] object-contain" />
          ) : (
            <p className="break-all rounded-[12px] border border-line bg-white px-3 py-2 text-[15px]"><span className="font-bold">{file.name}</span></p>
          )}
          <div className="flex flex-col gap-2">
            <button type="button" className={BIG} disabled={disabled} onClick={() => { onFile(null); setMode("camera"); }} data-testid="pod-retake">
              Retake POD photo
            </button>
            <button type="button" className={LINK} disabled={disabled} onClick={() => onFile(null)} data-testid="pod-remove">
              Remove it
            </button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" className={BIG} disabled={disabled} onClick={() => setMode("camera")} data-testid="pod-take">
            {label}
          </button>
          <button type="button" className={LINK} disabled={disabled} onClick={() => setMode("file")} data-testid="pod-choose-file">
            Choose a file instead
          </button>
        </>
      )}
    </div>
  );
}
