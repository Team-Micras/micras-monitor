import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { roleVariable, type Role, type SerializableType } from '@/robot-kit';

import { Button } from '../../components/ui/button';
import { useLinkUp, useLiveValue, useMonitor, useRobotPackage } from '../../monitor-context';
import type { ReactRobotPackage } from '../../monitor-context';
import { usePresentedVariables } from '../shared/presented-variables';
import type { WindowViewProps } from '../types';
import { CoalescedReads } from './coalesced-reads';
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

function useRoleValue(
  pkg: ReactRobotPackage | null,
  role: Role,
  follow: boolean
): number | undefined {
  const value = useLiveValue(follow ? roleVariable(pkg, role) : null)?.value;
  return typeof value === 'number' ? value : undefined;
}

function definedRoles(
  entries: readonly (readonly [Role, number | undefined])[]
): Partial<Record<Role, number>> {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

/**
 * A blob through the view of its serializable type, or as a hexadecimal dump when no package
 * decodes it. The blob is read once the schema has it, and read again when the value of the
 * package's revision of it changes from one it had, one READ at a time. The view of the map also
 * gets the robot's pose.
 */
export function TypeViewWindow({ window }: WindowViewProps) {
  const { reads, values } = useMonitor().ports;
  const pkg = useRobotPackage()?.package ?? null;
  const [entry] = usePresentedVariables(window.payload.variables.slice(0, 1));
  const name = entry?.name ?? null;
  const latest = useLiveValue(name)?.value;
  const revision = name === null ? null : revisionOf(pkg, name);
  const map = revision !== null;
  const roles = definedRoles([
    ['pose.x', useRoleValue(pkg, 'pose.x', map)],
    ['pose.y', useRoleValue(pkg, 'pose.y', map)],
    ['pose.heading', useRoleValue(pkg, 'pose.heading', map)],
  ]);
  const linked = useLinkUp();
  const [failure, setFailure] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const reader = useRef<CoalescedReads | null>(null);

  const readAgain = () => {
    setReading(true);
    reader.current?.request();
  };

  const variableId = entry?.variable?.id;

  useEffect(() => {
    if (!linked || name === null || variableId === undefined) {
      return undefined;
    }

    let cancelled = false;
    const blob = new CoalescedReads(() =>
      reads.read(name).then((outcome) => {
        if (!cancelled) {
          setReading(false);
          setFailure(outcome.status === 'failed' ? outcome.message : null);
        }
      })
    );
    reader.current = blob;
    blob.request();
    return () => {
      cancelled = true;
      blob.close();
      reader.current = null;
    };
  }, [reads, linked, name, variableId]);

  useEffect(() => {
    if (!linked || revision === null) {
      return undefined;
    }

    let seen = values.latest(revision)?.value;
    return values.subscribe([revision], () => {
      const value = values.latest(revision)?.value;

      if (value !== seen) {
        const known = seen !== undefined;
        seen = value;

        if (known) {
          reader.current?.request();
        }
      }
    });
  }, [values, linked, revision]);

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
        <span className="font-mono">{entry.presentation?.typeLabel ?? entry.name}</span>
        {entry.missing ? <span data-missing>· missing from the schema</span> : null}
        {bytes === null ? null : <span className="font-mono">· {bytes.length} B</span>}
        {failure === null ? null : <span className="text-destructive">· {failure}</span>}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label={`Read ${entry.name} again`}
          disabled={!linked || reading || entry.missing}
          onClick={readAgain}
        >
          <RefreshCwIcon className={reading ? 'animate-spin' : undefined} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {bytes === null ? (
          <p className="text-sm text-muted-foreground">
            {entry.missing
              ? 'The schema of this robot has no such variable.'
              : linked
                ? 'Reading…'
                : 'Connect to a robot to read it.'}
          </p>
        ) : decoded?.kind === 'value' && serializable !== null ? (
          <serializable.View key={serializable.tag} value={decoded.value} roles={roles} />
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
