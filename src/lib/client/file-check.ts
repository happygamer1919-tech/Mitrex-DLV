// Pure file validation shared by DropZone and its tests. No browser APIs.
export type FileRule = { exts: string[]; maxBytes: number; typeError?: string; sizeError?: string };

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Returns an error message, or null when the file is acceptable.
export function checkFile(file: { name: string; size: number }, rule: FileRule): string | null {
  if (!rule.exts.includes(extOf(file.name))) {
    return rule.typeError ?? `Use one of these file types: ${rule.exts.join(", ")}.`;
  }
  if (file.size > rule.maxBytes) {
    return rule.sizeError ?? `The file is larger than ${Math.round(rule.maxBytes / (1024 * 1024))} MB.`;
  }
  if (file.size === 0) return "That file is empty. Choose another one.";
  return null;
}
