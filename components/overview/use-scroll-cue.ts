"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

/** How close to an end still counts as "at" it, allowing for rounding. */
const EDGE_SLOP = 4;

/**
 * The two silent cues that a strip scrolls.
 *
 * A phone hides the scrollbar, so a scroller at rest looks exactly like a chart
 * that simply ends at the card's edge. Nothing in the card says otherwise. Two
 * things say it without a sentence:
 *
 * - `data-more` on the strip names which edge still has content, and the
 *   stylesheet fades that edge. It is set from the scroll position, so the fade
 *   disappears the moment the reader reaches the end and appears behind them.
 * - The rail is a track with a thumb the width of the visible span, so a
 *   twelve-screen strip reads as twelve screens rather than as a chart that is
 *   mysteriously cut off.
 *
 * Both are written straight to the DOM: a scroll handler that sets React state
 * would re-render the chart on every frame.
 */
export const useScrollCue = (
  /** The scroller: a `section`, because a named one is a region landmark. */
  stripRef: RefObject<HTMLElement | null>,
  railRef: RefObject<HTMLDivElement | null>
) => {
  useEffect(() => {
    const strip = stripRef.current;
    const rail = railRef.current;
    if (!strip || !rail) {
      return;
    }

    const update = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      const atStart = strip.scrollLeft <= EDGE_SLOP;
      const atEnd = strip.scrollLeft >= max - EDGE_SLOP;

      if (max <= EDGE_SLOP) {
        delete strip.dataset.more;
      } else if (atStart) {
        strip.dataset.more = "end";
      } else if (atEnd) {
        strip.dataset.more = "start";
      } else {
        strip.dataset.more = "both";
      }

      rail.hidden = strip.scrollWidth <= strip.clientWidth;
      rail.firstElementChild?.setAttribute(
        "style",
        `width:${(strip.clientWidth / strip.scrollWidth) * 100}%;left:${(strip.scrollLeft / strip.scrollWidth) * 100}%`
      );
    };

    update();
    strip.addEventListener("scroll", update, { passive: true });

    // Rotation and a range change both resize the content, and neither fires a
    // scroll event on its own. Guarded: older Safari and jsdom have no
    // observer, and a missing cue is better than a crashed chart.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(strip);
    if (observer && strip.firstElementChild) {
      observer.observe(strip.firstElementChild);
    }

    return () => {
      strip.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [stripRef, railRef]);
};
