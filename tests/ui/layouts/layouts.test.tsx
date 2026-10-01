import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry, type LayoutPreset, type RobotPackage } from '@/core/robot';
import { mouse } from '@tests/support/core/robot/packages';
import { activeWorkspace, leafIds } from '@/tiling';

import { App } from '@/ui/app';
import type { AppMonitor } from '@/ui/monitor-context';
import { createShellStore, type ShellStore } from '@/ui/state/shell-store';
import '@/ui/styles.css';
import { LayoutBook, STORAGE_PREFIX } from '@/ui/layouts/saved-layouts';
import type { DemoRobot, DemoVariable } from '@/sources/demo/demo-source';
import { MemoryStorage } from '@tests/support/ui/layouts/memory-storage';
import { DEMO_TARGET, demoMonitor } from '@tests/support/sources/demo-monitor';

const STREAM = { stream: true, write: false, writeNeedsIdle: false, persists: false };
const NAMES = Array.from({ length: 12 }, (_, index) => `sensor/s${index}`);

const PRESETS: LayoutPreset[] = [
  { name: 'Overview', root: { window: { kind: 'log' } } },
  {
    name: 'Speeds',
    root: { window: { kind: 'plot', title: 'Speeds', variables: ['sensor/s0', 'sensor/s1'] } },
  },
];

function variables(...names: string[]): DemoVariable[] {
  return names.map((name) => ({ name, type: 'f32', access: STREAM }));
}

interface Mounted {
  readonly store: ShellStore;
  readonly monitor: AppMonitor;
  readonly storage: MemoryStorage;
  readonly screen: Awaited<ReturnType<typeof render>>;
}

interface Options {
  readonly storage?: MemoryStorage;
  readonly robot?: Partial<DemoRobot>;
  readonly packages?: readonly RobotPackage<ReactNode>[];
}

const monitors: AppMonitor[] = [];

afterEach(() => {
  monitors.splice(0).forEach((monitor) => monitor.disconnect());
});

async function mount(options: Options = {}): Promise<Mounted> {
  const storage = options.storage ?? new MemoryStorage();
  const monitor = demoMonitor({
    sampleRateHz: 50,
    robot: { name: 'rover', variables: variables(...NAMES), ...options.robot },
  });
  monitors.push(monitor);
  const store = createShellStore({ theme: 'dark' });
  const screen = await render(
    <App
      monitor={monitor}
      robots={new RobotRegistry(options.packages ?? [])}
      store={store}
      layouts={storage}
      synthetic
    />
  );
  return { store, monitor, storage, screen };
}

async function connect({ monitor }: Mounted): Promise<void> {
  monitor.connect(DEMO_TARGET);
  await expect.poll(() => monitor.state.status.kind).toBe('linked');
}

function workspaceNames({ store }: Pick<Mounted, 'store'>): string[] {
  return store.getState().desktop.workspaces.map((workspace) => workspace.name);
}

async function saved({ storage }: Mounted, key: string, count: number): Promise<void> {
  await expect
    .poll(() => new LayoutBook(storage).load(key, [])?.desktop?.workspaces.length)
    .toBe(count);
}

async function launch(screen: Mounted['screen'], command: string): Promise<void> {
  await userEvent.keyboard('{Control>}k{/Control}');
  const input = screen.getByPlaceholder('Open a window or run an action…');
  await expect.element(input).toHaveFocus();
  await input.fill(command);
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByRole('dialog', { name: 'Launcher' })).not.toBeInTheDocument();
}

describe('the layout of a robot', () => {
  test('starts as an automatic layout from the schema of a robot without a package', async () => {
    const mounted = await mount();
    await connect(mounted);
    expect(workspaceNames(mounted)).toEqual(['Overview', 'Sensor']);
    await expect
      .element(mounted.screen.getByRole('region', { name: 'Workspace Overview' }))
      .toBeVisible();
    await expect.element(mounted.screen.getByRole('tab', { name: 'Sensor' })).toBeVisible();
  });

  test('is restored when the robot connects again in a new visit', async () => {
    const first = await mount();
    await connect(first);
    await first.screen.getByRole('button', { name: 'Add a workspace' }).click();
    expect(workspaceNames(first)).toEqual(['Overview', 'Sensor', 'Workspace 3']);
    await saved(first, 'name:rover', 3);
    await first.screen.unmount();

    const second = await mount({ storage: first.storage });
    await connect(second);
    expect(workspaceNames(second)).toEqual(['Overview', 'Sensor', 'Workspace 3']);
    expect(second.store.getState().desktop.active).toBe(2);
  });

  test('keeps the order the workspaces were moved to', async () => {
    const first = await mount();
    await connect(first);
    await expect.element(first.screen.getByRole('tab', { name: 'Sensor' })).toBeVisible();
    await userEvent.keyboard('{Alt>}{Shift>}{PageDown}{/Shift}{/Alt}');
    expect(workspaceNames(first)).toEqual(['Sensor', 'Overview']);
    await expect
      .poll(() =>
        new LayoutBook(first.storage)
          .load('name:rover', [])
          ?.desktop?.workspaces.map((workspace) => workspace.name)
      )
      .toEqual(['Sensor', 'Overview']);
    await first.screen.unmount();

    const second = await mount({ storage: first.storage });
    await connect(second);
    expect(workspaceNames(second)).toEqual(['Sensor', 'Overview']);
  });

  test('stays on screen when the robot disconnects, and after it connects again', async () => {
    const mounted = await mount();
    await connect(mounted);
    await mounted.screen.getByRole('button', { name: 'Add a workspace' }).click();
    mounted.monitor.disconnect();
    await expect.poll(() => mounted.monitor.state.status.kind).toBe('disconnected');
    expect(workspaceNames(mounted)).toEqual(['Overview', 'Sensor', 'Workspace 3']);

    await mounted.screen.getByRole('button', { name: 'Add a workspace' }).click();
    await connect(mounted);
    expect(workspaceNames(mounted)).toEqual(['Overview', 'Sensor', 'Workspace 3', 'Workspace 4']);
  });

  test('is kept by a schema that gains a variable, and shows the new variable in the drawer', async () => {
    const first = await mount({ robot: { name: null } });
    await connect(first);
    first.store.getState().run({ type: 'renameWorkspace', index: 1, name: 'Mine' });
    const keyA = first.storage.key(0)?.slice(STORAGE_PREFIX.length) ?? '';
    await saved(first, keyA, 2);
    await first.screen.unmount();

    const second = await mount({
      storage: first.storage,
      robot: { name: null, variables: variables(...NAMES, 'sensor/extra') },
    });
    await connect(second);
    expect(workspaceNames(second)).toEqual(['Overview', 'Mine']);
    expect(first.storage.getItem(`${STORAGE_PREFIX}${keyA}`)).not.toBeNull();
  });

  test('is another for another robot', async () => {
    const first = await mount();
    await connect(first);
    await first.screen.getByRole('button', { name: 'Add a workspace' }).click();
    await saved(first, 'name:rover', 3);
    await first.screen.unmount();

    const other = await mount({
      storage: first.storage,
      robot: { name: 'crawler', variables: variables('leg/a', 'leg/b') },
    });
    await connect(other);
    expect(workspaceNames(other)).toEqual(['Overview', 'Leg']);
    await other.screen.unmount();

    const again = await mount({ storage: first.storage });
    await connect(again);
    expect(workspaceNames(again)).toEqual(['Overview', 'Sensor', 'Workspace 3']);
  });

  test('starts as the presets of its package and is kept from then on', async () => {
    const pkg = mouse({ id: 'rover', displayName: 'Rover', presets: PRESETS });
    const first = await mount({ packages: [pkg] });
    await connect(first);
    expect(workspaceNames(first)).toEqual(['Overview', 'Speeds']);
    expect(leafIds(activeWorkspace(first.store.getState().desktop).root)).toHaveLength(1);
    first.store.getState().run({ type: 'renameWorkspace', index: 1, name: 'Mine' });
    await saved(first, 'name:rover', 2);
    await first.screen.unmount();

    const second = await mount({ storage: first.storage, packages: [pkg] });
    await connect(second);
    expect(workspaceNames(second)).toEqual(['Overview', 'Mine']);
  });

  test('is the automatic layout once the saved one is corrupt', async () => {
    const storage = new MemoryStorage();
    storage.setItem(`${STORAGE_PREFIX}name:rover`, '{"version":1,"desktop":{"version":9}');
    const mounted = await mount({ storage });
    await connect(mounted);
    expect(workspaceNames(mounted)).toEqual(['Overview', 'Sensor']);
  });
});

describe('layout presets', () => {
  test('are saved from the layouts menu and applied from it', async () => {
    const mounted = await mount();
    await connect(mounted);
    const { screen, store } = mounted;
    await screen.getByRole('button', { name: 'Layouts' }).click();
    await screen.getByRole('textbox', { name: 'Layout name' }).fill('Bench');
    await screen.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.element(screen.getByRole('button', { name: 'Rename Bench' })).toBeVisible();

    await screen.getByRole('button', { name: 'Bench', exact: true }).click();
    expect(workspaceNames(mounted)).toEqual(['Overview', 'Sensor', 'Bench']);
    expect(store.getState().desktop.active).toBe(2);
    await expect
      .element(screen.getByRole('button', { name: 'Rename Bench' }))
      .not.toBeInTheDocument();
    await saved(mounted, 'name:rover', 3);
    expect(new LayoutBook(mounted.storage).load('name:rover', [])?.presets).toHaveLength(1);
  });

  test('are renamed and deleted from the layouts menu', async () => {
    const mounted = await mount();
    await connect(mounted);
    const { screen, store } = mounted;
    store.getState().savePreset('Bench');
    await screen.getByRole('button', { name: 'Layouts' }).click();
    await screen.getByRole('button', { name: 'Rename Bench' }).click();
    await screen.getByRole('textbox', { name: 'New name for Bench' }).fill('Track day');
    await userEvent.keyboard('{Enter}');
    expect(store.getState().presets.map((preset) => preset.name)).toEqual(['Track day']);

    await screen.getByRole('button', { name: 'Delete Track day' }).click();
    expect(store.getState().presets).toEqual([]);
    await expect.element(screen.getByText('None yet.')).toBeVisible();
  });

  test('of the package are read only, and the workspace they make can be saved as a new one', async () => {
    const pkg = mouse({ id: 'rover', displayName: 'Rover', presets: PRESETS });
    const mounted = await mount({ packages: [pkg] });
    await connect(mounted);
    const { screen, store } = mounted;
    await screen.getByRole('button', { name: 'Layouts' }).click();
    await expect.element(screen.getByText('Rover layouts')).toBeVisible();
    await expect
      .element(screen.getByRole('button', { name: 'Rename Speeds' }))
      .not.toBeInTheDocument();

    await screen.getByRole('button', { name: 'Speeds', exact: true }).click();
    expect(workspaceNames(mounted)).toEqual(['Overview', 'Speeds', 'Speeds 2']);

    await screen.getByRole('button', { name: 'Layouts' }).click();
    await screen.getByRole('button', { name: 'Save', exact: true }).click();
    expect(store.getState().presets.map((preset) => preset.name)).toEqual(['Speeds 2']);
  });

  test('are saved when the page is left, without waiting for the delay', async () => {
    const mounted = await mount();
    await connect(mounted);
    await mounted.screen.getByRole('button', { name: 'Add a workspace' }).click();
    window.dispatchEvent(new Event('pagehide'));
    expect(
      new LayoutBook(mounted.storage).load('name:rover', [])?.desktop?.workspaces
    ).toHaveLength(3);
  });

  test('take Escape in the rename field as cancelling the rename, and only then close', async () => {
    const mounted = await mount();
    await connect(mounted);
    const { screen, store } = mounted;
    store.getState().savePreset('Bench');
    await screen.getByRole('button', { name: 'Layouts' }).click();
    await screen.getByRole('button', { name: 'Rename Bench' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'New name for Bench' })).toBeVisible();

    await userEvent.keyboard('{Escape}');
    await expect
      .element(screen.getByRole('textbox', { name: 'New name for Bench' }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: 'Bench', exact: true })).toHaveFocus();
    await expect.element(screen.getByRole('textbox', { name: 'Layout name' })).toBeVisible();
    expect(store.getState().layoutsOpen).toBe(true);

    await userEvent.keyboard('{Escape}');
    await expect
      .element(screen.getByRole('textbox', { name: 'Layout name' }))
      .not.toBeInTheDocument();
  });

  test('keep the focus in the menu after a rename and after a delete', async () => {
    const mounted = await mount();
    await connect(mounted);
    const { screen, store } = mounted;
    ['One', 'Two', 'Three'].forEach((name) => store.getState().savePreset(name));
    await screen.getByRole('button', { name: 'Layouts' }).click();

    await screen.getByRole('button', { name: 'Rename One' }).click();
    await screen.getByRole('textbox', { name: 'New name for One' }).fill('Uno');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('button', { name: 'Uno', exact: true })).toHaveFocus();

    await screen.getByRole('button', { name: 'Delete Uno' }).click();
    await expect.element(screen.getByRole('button', { name: 'Two', exact: true })).toHaveFocus();
    await screen.getByRole('button', { name: 'Delete Three' }).click();
    await expect.element(screen.getByRole('button', { name: 'Two', exact: true })).toHaveFocus();
    await screen.getByRole('button', { name: 'Delete Two' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Layout name' })).toHaveFocus();
  });

  test('can be brought back after a delete, from the menu or the launcher', async () => {
    const mounted = await mount();
    await connect(mounted);
    const { screen, store } = mounted;
    store.getState().savePreset('Bench');
    await screen.getByRole('button', { name: 'Layouts' }).click();
    await screen.getByRole('button', { name: 'Delete Bench' }).click();
    expect(store.getState().presets).toEqual([]);
    await expect
      .element(screen.getByRole('status', { name: 'Layout deleted' }))
      .toHaveTextContent('Deleted layout Bench');
    await screen.getByRole('button', { name: 'Undo' }).click();
    expect(store.getState().presets.map((preset) => preset.name)).toEqual(['Bench']);
    await userEvent.keyboard('{Escape}');

    await launch(screen, 'delete layout Bench');
    await expect.element(screen.getByRole('status', { name: 'Layout deleted' })).toBeVisible();
    await screen.getByRole('button', { name: 'Undo' }).click();
    expect(store.getState().presets.map((preset) => preset.name)).toEqual(['Bench']);
  });

  test('do not take the name of a layout of the package by default', async () => {
    const pkg = mouse({ id: 'rover', displayName: 'Rover', presets: PRESETS });
    const mounted = await mount({ packages: [pkg] });
    await connect(mounted);
    const { screen, store } = mounted;
    store.getState().run({ type: 'switchWorkspace', index: 1 });
    await screen.getByRole('button', { name: 'Layouts' }).click();
    await expect
      .element(screen.getByRole('textbox', { name: 'Layout name' }))
      .toHaveAttribute('placeholder', 'Speeds (mine)');
    await screen.getByRole('button', { name: 'Save', exact: true }).click();
    expect(store.getState().presets.map((preset) => preset.name)).toEqual(['Speeds (mine)']);
  });

  test('name the robot in the launcher for the layouts of its package', async () => {
    const pkg = mouse({ id: 'rover', displayName: 'Rover', presets: PRESETS });
    const mounted = await mount({ packages: [pkg] });
    await connect(mounted);
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect
      .element(mounted.screen.getByRole('option', { name: 'Apply layout Speeds Rover' }))
      .toBeVisible();
  });

  test('have commands in the launcher', async () => {
    const mounted = await mount();
    await connect(mounted);
    const { screen, store } = mounted;
    store.getState().savePreset('Bench');

    await launch(screen, 'apply layout Bench');
    await expect.poll(() => workspaceNames(mounted)).toEqual(['Overview', 'Sensor', 'Bench']);

    await launch(screen, 'rename layout Bench');
    await expect.element(screen.getByRole('textbox', { name: 'New name for Bench' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Escape}');

    await launch(screen, 'delete layout Bench');
    await expect.poll(() => store.getState().presets).toEqual([]);

    await launch(screen, 'save workspace as a layout');
    await expect.element(screen.getByRole('textbox', { name: 'Layout name' })).toHaveFocus();
  });
});
