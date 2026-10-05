import { btnClass, Card } from "@/components/ui";
import { fmtSlot, telHref } from "@/lib/format";
import type { Location, Timing } from "@/lib/types";

type Props = {
  title: string;
  location: Location | null;
  timing: Timing;
  date: string;
  start: string;
  end: string | null;
  contactName: string;
  contactPhone: string;
};

export function StopCard({ title, location, timing, date, start, end, contactName, contactPhone }: Props) {
  const addressLine = location
    ? [location.address_line, location.city, location.province, location.postal_code].filter(Boolean).join(", ")
    : "";
  return (
    <Card className="space-y-3 text-ink">
      <h2 className="text-[20px] font-bold">{title}</h2>
      <div>
        <div className="break-words text-[16px] font-bold">{location?.name ?? "Location not available"}</div>
        {location ? (
          <address className="not-italic text-[16px]">
            <div className="break-words">{location.address_line}</div>
            <div>
              {location.city}, {location.province}
              {location.postal_code ? ` ${location.postal_code}` : ""}
            </div>
          </address>
        ) : null}
      </div>
      <div>
        <div className="text-[13px] font-medium text-muted">{timing === "appointment" ? "Appointment" : "Window"}</div>
        <div className="text-[16px] font-bold">{fmtSlot(timing, date, start, end)}</div>
      </div>
      {location?.notes ? (
        <div>
          <div className="text-[13px] font-medium text-muted">Site notes</div>
          <div className="whitespace-pre-line break-words text-[15px]">{location.notes}</div>
        </div>
      ) : null}
      <div className="space-y-2 pt-1">
        <a href={telHref(contactPhone)} className={`${btnClass("dark", true)} min-h-[64px] w-full flex-col !px-4 !py-2 leading-tight`}>
          <span className="text-[13px] font-medium text-white/80">Call {contactName}</span>
          <span className="text-[20px]">{contactPhone}</span>
        </a>
        {addressLine ? (
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLine)}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`${btnClass("ghost")} min-h-[48px] w-full`}
          >
            Open in Maps
          </a>
        ) : null}
      </div>
    </Card>
  );
}
