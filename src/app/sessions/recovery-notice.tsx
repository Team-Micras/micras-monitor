import { HistoryIcon, XIcon } from 'lucide-react';

import { Button } from '../components/ui/button';
import { describeRecovery } from './session-text';
import { useSessionManager, useSessions } from './sessions-context';

/**
 * The notice that a recording a closed tab left behind was recovered, with a way to open it.
 *
 * @param onOpenList Shows the sessions list, for more than one.
 */
export function RecoveryNotice({ onOpenList }: { readonly onOpenList: () => void }) {
  const manager = useSessionManager();
  const recovered = useSessions()?.recovered ?? [];

  if (manager === null || recovered.length === 0) {
    return null;
  }

  const [first] = recovered;
  const single = recovered.length === 1;

  return (
    <output
      aria-label="Recovered recording"
      data-recovered={recovered.map((entry) => entry.session.id).join(' ')}
      className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border bg-popover py-1.5 pr-1.5 pl-3.5 text-sm text-popover-foreground shadow-md"
    >
      <HistoryIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {single ? `Recovered ${first.session.name}` : `Recovered ${recovered.length} recordings`}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {single ? describeRecovery(first) : 'The tab closed while they were recording'}
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          manager.dismissRecovered();

          if (single) {
            void manager.open(first.session.id);
          } else {
            onOpenList();
          }
        }}
      >
        {single ? 'Open' : 'Show'}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={() => manager.dismissRecovered()}
      >
        <XIcon />
      </Button>
    </output>
  );
}
