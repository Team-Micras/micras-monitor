import { useState, type ReactNode } from 'react';

import { AnnounceContext, type Announce, type Politeness } from '../shell-contexts';

interface Message {
  readonly id: number;
  readonly text: string;
}

const NONE: Message = { id: 0, text: '' };

/**
 * The two live regions of the app, one polite and one assertive, and the function that fills
 * them. A message is a new element each time, so the same words twice are read twice. The events
 * it carries (connection, state, STOP, commands, recording, failed windows) are not live on
 * screen as well, so a screen reader hears each once; notices with a life of their own, such as
 * the update and recovery notices, keep their own roles.
 */
export function Announcer({ children }: { readonly children: ReactNode }) {
  const [polite, setPolite] = useState(NONE);
  const [assertive, setAssertive] = useState(NONE);

  const announce: Announce = (text, politeness: Politeness = 'polite') => {
    const set = politeness === 'assertive' ? setAssertive : setPolite;
    set((last) => ({ id: last.id + 1, text }));
  };

  return (
    <AnnounceContext value={announce}>
      {children}
      <div className="sr-only">
        <output aria-live="polite" aria-atomic data-announcer="polite">
          {polite.text === '' ? null : <p key={polite.id}>{polite.text}</p>}
        </output>
        <output aria-live="assertive" aria-atomic data-announcer="assertive">
          {assertive.text === '' ? null : <p key={assertive.id}>{assertive.text}</p>}
        </output>
      </div>
    </AnnounceContext>
  );
}
