"use client";

import { receiptZone } from "@/lib/receipt/zone-caption";

/**
 * The word for "where" beside a receipt's time (#200).
 *
 * It stays `inline` at the root so it can sit inside a paragraph as well as
 * under a form field. In the form it follows the form's own values rather than
 * the stored row, so correcting the zone or the time updates it before the
 * save; the time itself is not restated, because the field above already says
 * it in the paper's own words.
 *
 * `id` is optional because a caption that is a description for a nearby control
 * needs one, and one that is simply read in place (the detail page) does not.
 */
export const ReceiptZoneCaption = ({
  id,
  viewerZone,
  wallClock,
  zone,
}: {
  id?: string;
  viewerZone: string;
  wallClock: string | undefined;
  zone: string | undefined;
}) => {
  const caption = receiptZone({
    viewerZone,
    wallClock: wallClock ?? "",
    zone,
  });

  if (!caption) {
    return null;
  }

  return (
    <span className="text-muted-foreground mt-1 block text-xs" id={id}>
      Added from {caption.label}
      {caption.viewerTime ? (
        <span className="block">{caption.viewerTime}</span>
      ) : null}
    </span>
  );
};
