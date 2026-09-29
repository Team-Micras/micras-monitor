import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';

import { roleVariable, type SerializableType } from '@/robot-kit';

import { Button } from '../../components/ui/button';
import { useLinkUp, useLiveValue, useMonitor, useRobotPackage } from '../../monitor-context';
import type { ReactRobotPackage } from '../../monitor-context';
import { usePresentedVariables } from '../shared/presented-variables';
import type { WindowViewProps } from '../types';
import { hexRows } from './hex-dump';

type Decoded =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'error'; readonly message: string };

function decode(type: SerializableType, bytes: Uint8Array): Decoded {
  try {
    return { kind: 'value', value: type.decode(bytes) };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function revisionOf(pkg: ReactRobotPackage | null, name: string): string | null {
  return roleVariable(pkg, 'map') === name ? roleVariable(pkg, 'map.revision') : null;
}

/**
 * A blob through the view of its serializable type, or as a hexadecimal dump when no package
 * decodes it. The blob is read on demand when it is not streamed, and read again whenever the
 * package's revision of it changes.
 */
export function TypeViewWindow({ window }: WindowViewProps) {
  const { reads, values } = useMonitor().ports;
  const pkg = useRobotPackage()?.package ?? null;
  const [entry] = usePresentedVariables(window.payload.variables.slice(0, 1));
  const name = entry?.name ?? null;
  const latest = useLiveValue(name)?.value;
  const revision = name === null ? null : revisionOf(pkg, name);
  const linked = useLinkUp();
  const [failure, setFailure] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const request = (variable: string) =>
    reads.read(variable).then((outcome) => {
      setReading(false);
      setFailure(outcome.status === 'failed' ? outcome.message : null);
    });

  const readAgain = (variable: string) => {
    setReading(true);
    void request(variable);
  };

  const readNow = useEffectEvent((variable: string) => void request(variable));

  useEffect(() => {
    if (linked && name !== null) {
      readNow(name);
    }
  }, [linked, name]);

  useEffect(() => {
    if (!linked || name === null || revision === null) {
      return undefined;
    }

    return values.subscribe([revision], () => readNow(name));
  }, [values, linked, name, revision]);

  if (entry === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Drag a blob here from the drawer
      </div>
    );
  }

  const serializable = entry.presentation?.serializable ?? null;
  const bytes = latest instanceof Uint8Array ? latest : null;
  const decoded = bytes !== null && serializable !== null ? decode(serializable, bytes) : null;

  return (
    <div className="flex h-full flex-col gap-3 px-5 pt-1 pb-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{entry.presentation?.typeLabel ?? 'not in schema'}</span>
        {bytes === null ? null : <span className="font-mono">· {bytes.length} B</span>}
        {failure === null ? null : <span className="text-destructive">· {failure}</span>}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label={`Read ${entry.name} again`}
          disabled={!linked || reading}
          onClick={() => readAgain(entry.name)}
        >
          <RefreshCwIcon className={reading ? 'animate-spin' : undefined} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {bytes === null ? (
          <p className="text-sm text-muted-foreground">
            {linked ? 'Reading…' : 'Connect to a robot to read it.'}
          </p>
        ) : decoded?.kind === 'value' && serializable !== null ? (
          <SerializableView key={serializable.tag} type={serializable} value={decoded.value} />
        ) : (
          <>
            {decoded?.kind === 'error' ? (
              <p role="alert" className="mb-2 text-xs text-destructive">
                Could not decode {serializable?.name}: {decoded.message}
              </p>
            ) : null}
            <HexDump bytes={bytes} />
          </>
        )}
      </div>
    </div>
  );
}

function SerializableView({
  type,
  value,
}: {
  readonly type: SerializableType<unknown, ReactNode>;
  readonly value: unknown;
}) {
  return type.View({ value });
}

function HexDump({ bytes }: { readonly bytes: Uint8Array }) {
  return (
    <table data-hex-dump className="font-mono text-xs leading-6 tabular-nums">
      <tbody>
        {hexRows(bytes).map((row) => (
          <tr key={row.offset}>
            <td className="pr-4 text-muted-foreground">{row.offset}</td>
            <td className="pr-4 whitespace-pre">{row.hex}</td>
            <td className="whitespace-pre text-muted-foreground">{row.ascii}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
