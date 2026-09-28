import { ClockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { formatClock } from '../lib/format';
import { useConnectionStatus } from '../monitor-context';

/** How long the link has been up, ticking every tenth of a second. */
export function SessionClock() {
  const status = useConnectionStatus();
  const since = status.kind === 'linked' ? status.since : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = since === null ? undefined : setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [since]);

  return (
    <span className="flex items-center gap-2 font-mono text-sm tabular-nums">
      <ClockIcon className="size-4 text-muted-foreground" aria-hidden />
      <span aria-label="Link time">{since === null ? '--:--.-' : formatClock(now - since)}</span>
    </span>
  );
}
