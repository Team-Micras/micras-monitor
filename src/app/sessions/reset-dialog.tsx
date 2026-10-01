import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { formatDuration } from '../lib/format';
import { useLiveMonitor } from '../monitor-context';
import type { SessionManager } from './session-manager';

interface ResetDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly manager: SessionManager;
  /** Whether a recording is under way, which the reset ends. */
  readonly recording: boolean;
}

/** Asks before forgetting the live history, which cannot be undone. */
export function ResetDialog({ open, onOpenChange, manager, recording }: ResetDialogProps) {
  const range = useLiveMonitor().history.timeRange();
  const liveMs = range ? (range.endUs - range.startUs) / 1000 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Reset the live session?</DialogTitle>
          <DialogDescription>
            Forgets the {formatDuration(liveMs)} of history in this tab
            {recording ? ' and ends the recording, which stays saved' : ''}. Saved sessions are
            kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              void manager.resetLive();
            }}
          >
            Reset session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
