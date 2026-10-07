import { customerHeadline, hasIts, itsOrRef, type LoadNumbers } from "@/lib/load-number";

type Audience = "customer" | "staff" | "carrier";

// Renders the load number for one audience. Inline, so it can sit inside a heading or a card title.
//  - ITS number set: the ITS number everywhere.
//  - not set, staff: "Request MTX-0005".
//  - not set, customer: "Number pending" plus the request ref as small muted secondary text.
//  - carrier: ITS number, or the request ref for a legacy booked load that never got one.
// The request ref sits in its own inner span so a lookup by the bare ref still finds it.
export function LoadNumber({ l, audience, refClassName = "text-[13px] font-normal text-muted" }: {
  l: LoadNumbers; audience: Audience; refClassName?: string;
}) {
  if (hasIts(l) || audience === "carrier") {
    return <span data-testid="load-number">{itsOrRef(l)}</span>;
  }
  if (audience === "staff") {
    return <span data-testid="load-number">Request <span data-testid="request-ref">{l.load_number}</span></span>;
  }
  const h = customerHeadline(l);
  return (
    <>
      <span data-testid="load-number">{h.headline}</span>{" "}
      <span className={refClassName}>Request <span data-testid="request-ref">{h.secondaryRef}</span></span>
    </>
  );
}
