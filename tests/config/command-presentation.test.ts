import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SPECIAL_STOP =
  /\bemergency\b|emergencyCommand|StopNotice|stopNotice|useStopAction|stop-button|stop-action|stop-outcome/i;

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('STOP as a plain command', () => {
  test('nothing in the monitor or its packages treats one command as the emergency stop', () => {
    const files = sources(join(ROOT, 'src'));
    const special = files
      .filter((path) => SPECIAL_STOP.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));

    expect(files.length).toBeGreaterThan(100);
    expect(special).toEqual([]);
  });
});
