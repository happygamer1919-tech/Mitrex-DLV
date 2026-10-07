// Load photos (DLV-032). Shared by the server pages and the browser components: no browser API at module level.
import type { LoadStatus } from "@/lib/types";

export type PhotoKind = "pickup_photo" | "delivery_photo";

export const MAX_PHOTOS = 6; // per kind per load, enforced by a database trigger too

export const PHOTO_TITLE: Record<PhotoKind, string> = {
  pickup_photo: "Loaded photo",
  delivery_photo: "Delivery photo",
};

// The photo step a status asks for: the loaded photo before leaving, the delivery photo before marking delivered.
export function photoKindForStatus(status: LoadStatus): PhotoKind | null {
  if (status === "loading") return "pickup_photo";
  if (status === "at_delivery") return "delivery_photo";
  return null;
}

export const PHOTO_BUTTON: Record<PhotoKind, string> = {
  pickup_photo: "Take loaded photo",
  delivery_photo: "Take delivery photo",
};

export const PHOTO_NEEDED_HINT: Record<PhotoKind, string> = {
  pickup_photo: "Take a photo of the loaded freight first. Then you can leave for delivery.",
  delivery_photo: "Take a photo of the delivered freight first. Then you can mark the load delivered.",
};

// What the carrier page hands to the client component for one stored photo. `when` is already Eastern time.
export type PhotoItem = { id: string; url: string | null; when: string; mine: boolean };
