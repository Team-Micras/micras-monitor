import { createContext, use } from 'react';

/** How urgently a screen reader is told: after what it is saying, or at once. */
export type Politeness = 'polite' | 'assertive';

/** Says something to screen readers through the live regions of the {@link Announcer}. */
export type Announce = (text: string, politeness?: Politeness) => void;

/** Carries the announce function; announcing does nothing where there is no announcer. */
export const AnnounceContext = createContext<Announce>(() => undefined);

/** The function that announces to screen readers. */
export function useAnnounce(): Announce {
  return use(AnnounceContext);
}
