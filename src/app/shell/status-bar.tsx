import { LayoutGridIcon, ListTreeIcon, MoonIcon, SunIcon } from 'lucide-react';

import { activeWorkspace, windowIds } from '@/tiling';

import { Button } from '../components/ui/button';
import { Kbd } from '../components/ui/kbd';
import { Separator } from '../components/ui/separator';
import { formatChord } from '../keymap/chords';
import { useMonitorScope } from '../monitor-context';
import { useShell, useShellStore } from '../state/shell-store';

/** The bar below the tiling: the variables drawer, the tiling's size and the theme. */
export function StatusBar() {
  const store = useShellStore();
  const { synthetic } = useMonitorScope();
  const count = useShell((state) => windowIds(activeWorkspace(state.desktop)).length);
  const theme = useShell((state) => state.theme);
  const drawerOpen = useShell((state) => state.overlay === 'drawer');
  const chord = useShell((state) => state.bindings.get('drawer')?.[0]);

  return (
    <footer className="flex h-10 shrink-0 items-center gap-2 px-2 text-sm text-muted-foreground">
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={drawerOpen}
        onClick={() => store.getState().setOverlay('drawer', true)}
        className="text-foreground aria-pressed:bg-accent"
      >
        <ListTreeIcon aria-hidden />
        Variables
        {chord === undefined ? null : <Kbd>{formatChord(chord).join('+')}</Kbd>}
      </Button>
      <Separator orientation="vertical" className="h-4!" />
      <span className="flex items-center gap-2 px-2">
        <LayoutGridIcon className="size-4" aria-hidden />
        Tiling · {count} {count === 1 ? 'window' : 'windows'}
      </span>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}
        onClick={() => store.getState().toggleTheme()}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </Button>
      {synthetic ? (
        <span className="rounded-md border px-2 py-0.5 text-xs">synthetic data</span>
      ) : null}
    </footer>
  );
}
