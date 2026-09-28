import { BluetoothIcon, ChevronDownIcon, GlobeIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { formatHash } from '../lib/format';
import { cn } from '../lib/utils';
import { useConnectionStatus, useMonitor, useRobotPackage } from '../monitor-context';
import type { ConnectionStatus, ConnectionTarget, LinkPhase, Transport } from '../ports';
import { useShell, useShellStore } from '../state/shell-store';

const URL_KEY = 'micras-monitor/websocket-url';
const DEFAULT_URL = 'ws://localhost:8080';

const TRANSPORT_LABELS: Readonly<Record<Transport, string>> = {
  websocket: 'WebSocket',
  bluetooth: 'Bluetooth',
};

type StatusStep = Exclude<ConnectionStatus['kind'], 'linked'> | LinkPhase;

const STATUS_WORDS: Readonly<Record<StatusStep, string>> = {
  disconnected: 'not connected',
  connecting: 'connecting',
  handshaking: 'handshaking',
  schema: 'reading schema',
  configuring: 'connected',
  streaming: 'connected',
  failed: 'failed',
};

const DOT_COLORS: Readonly<Record<StatusStep, string>> = {
  disconnected: 'bg-muted-foreground/50',
  connecting: 'bg-amber-500 animate-pulse',
  handshaking: 'bg-amber-500 animate-pulse',
  schema: 'bg-amber-500 animate-pulse',
  configuring: 'bg-emerald-500',
  streaming: 'bg-emerald-500',
  failed: 'bg-destructive',
};

function stepOf(status: ConnectionStatus): StatusStep {
  return status.kind === 'linked' ? status.phase : status.kind;
}

/**
 * The connection pill of the top bar and its popover: pick WebSocket or Bluetooth, connect and
 * disconnect, and see what the robot said about itself.
 */
export function ConnectionPopover() {
  const { connection } = useMonitor().ports;
  const status = useConnectionStatus();
  const selection = useRobotPackage();
  const store = useShellStore();
  const open = useShell((state) => state.connectionOpen);
  const [transport, setTransport] = useState<Transport>(
    status.kind === 'disconnected' ? 'websocket' : status.target.transport
  );
  const [url, setUrl] = useState(() => globalThis.localStorage?.getItem(URL_KEY) ?? DEFAULT_URL);
  const urlId = useId();
  const active = status.kind !== 'disconnected' && status.kind !== 'failed';
  const current = status.kind === 'disconnected' ? null : status.target.transport;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (active) {
      connection.disconnect();
      return;
    }

    const target: ConnectionTarget =
      transport === 'websocket' ? { transport, url: url.trim() } : { transport };

    if (target.transport === 'websocket') {
      globalThis.localStorage?.setItem(URL_KEY, target.url);
    }

    connection.connect(target);
  };

  return (
    <Popover open={open} onOpenChange={(next) => store.getState().setConnectionOpen(next)}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 rounded-full pr-3 pl-3.5 font-normal">
          <span className={cn('size-2 rounded-full', DOT_COLORS[stepOf(status)])} aria-hidden />
          <span className="font-medium">
            {current === null ? 'Connect' : TRANSPORT_LABELS[current]}
          </span>
          {current === null ? null : (
            <span className="text-muted-foreground">· {STATUS_WORDS[stepOf(status)]}</span>
          )}
          <ChevronDownIcon className="text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {(['websocket', 'bluetooth'] as const).map((option) => {
              const Icon = option === 'websocket' ? GlobeIcon : BluetoothIcon;
              const supported = connection.supports(option);
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={transport === option}
                  disabled={!supported || active}
                  onClick={() => setTransport(option)}
                  className={cn(
                    'flex h-8 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground transition-colors disabled:opacity-50',
                    transport === option && 'bg-background text-foreground shadow-sm'
                  )}
                  title={supported ? undefined : 'This browser has no Web Bluetooth'}
                >
                  <Icon className="size-4" aria-hidden />
                  {TRANSPORT_LABELS[option]}
                </button>
              );
            })}
          </div>
          {transport === 'websocket' ? (
            <div className="flex flex-col gap-1.5 text-sm">
              <label htmlFor={urlId} className="text-muted-foreground">
                Address
              </label>
              <Input
                id={urlId}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                disabled={active}
                spellCheck={false}
                className="font-mono"
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The browser asks which robot to pair with.
            </p>
          )}
          <StatusLine status={status} packageName={selection?.package.displayName ?? null} />
          <Button type="submit" variant={active ? 'outline' : 'default'}>
            {active ? 'Disconnect' : 'Connect'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function StatusLine({
  status,
  packageName,
}: {
  readonly status: ConnectionStatus;
  readonly packageName: string | null;
}) {
  if (status.kind === 'connecting') {
    return <p className="text-sm text-muted-foreground">Opening the connection…</p>;
  }

  if (status.kind === 'handshaking') {
    return <p className="text-sm text-muted-foreground">Waiting for the robot to answer…</p>;
  }

  if (status.kind === 'failed') {
    return (
      <p role="alert" className="text-sm text-destructive">
        {status.message}
      </p>
    );
  }

  if (status.kind === 'disconnected') {
    return null;
  }

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Robot</dt>
      <dd className="font-mono">{status.robot.name ?? 'unnamed'}</dd>
      <dt className="text-muted-foreground">Schema</dt>
      <dd className="font-mono">
        {formatHash(status.robot.schemaHash)}
        {status.phase === 'schema' ? (
          <span className="ml-2 font-sans text-muted-foreground">loading…</span>
        ) : null}
      </dd>
      <dt className="text-muted-foreground">Package</dt>
      <dd>{status.phase === 'schema' ? '—' : (packageName ?? 'none, raw mode')}</dd>
    </dl>
  );
}
