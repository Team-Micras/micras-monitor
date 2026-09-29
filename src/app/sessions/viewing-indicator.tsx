import { HistoryIcon, Undo2Icon } from 'lucide-react';

import { Button } from '../components/ui/button';
import type { OpenedSession } from './session-manager';
import { useSessionManager, useSessions, useStoreStatus } from './sessions-context';

/** Which saved session is on screen, with the way back to the live one. */
export function ViewingIndicator() {
  const manager = useSessionManager();
  const viewing = useSessions()?.viewing ?? null;

  if (manager === null || viewing === null) {
    return null;
  }

  return <Indicator viewing={viewing} onLive={() => void manager.backToLive()} />;
}

function Indicator({
  viewing,
  onLive,
}: {
  readonly viewing: OpenedSession;
  readonly onLive: () => void;
}) {
  const status = useStoreStatus(viewing.store);

  return (
    <div
      data-viewing={viewing.session.id}
      data-load-ms={Math.round(viewing.loadMs)}
      data-resident-blocks={status.residentBlocks}
      data-evicted-blocks={status.evictedBlocks}
      data-block-reads={viewing.blocks.reads}
      className="flex h-9 min-w-0 items-center gap-2 rounded-full border bg-muted/60 pr-1 pl-3 text-sm"
    >
      <HistoryIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Saved session" />
      <span className="truncate font-medium" title={`Saved session ${viewing.session.name}`}>
        {viewing.session.name}
      </span>
      <Button variant="default" size="xs" className="h-7 rounded-full px-2.5" onClick={onLive}>
        <Undo2Icon />
        Live
      </Button>
    </div>
  );
}
