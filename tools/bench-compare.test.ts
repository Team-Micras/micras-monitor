import { describe, expect, test } from 'vitest';

import {
  bestOf,
  checkBudgets,
  compareWithBaseline,
  isBenchRecord,
  timingsOf,
} from './bench-compare';
import type { BenchResult } from './bench-result';

const PLOTS = 'eight live plots';
const SESSION = 'the session';

function budgeted(frameP95Ms: number): BenchResult {
  return { timings: { frameP95Ms, intervalP95Ms: 16.7 }, budgets: { frameP95Ms: 8 }, summary: '' };
}

describe('compareWithBaseline against the stored baseline', () => {
  test('passes timings within 1.5 times their baseline plus 0.5 ms', () => {
    const verdict = compareWithBaseline(
      { [PLOTS]: { frameP95Ms: 3.5 } },
      { [PLOTS]: { frameP95Ms: 2 } }
    );
    expect(verdict.failed).toBe(false);
    expect(verdict.lines).toEqual([expect.stringMatching(/frameP95Ms 3\.50 ms .*: ok$/)]);
  });

  test('fails a timing past its limit', () => {
    const verdict = compareWithBaseline(
      { [PLOTS]: { frameP95Ms: 3.6 } },
      { [PLOTS]: { frameP95Ms: 2 } }
    );
    expect(verdict.failed).toBe(true);
    expect(verdict.lines.join('\n')).toContain('REGRESSED');
  });

  test('fails a test or a timing of the baseline that was not measured', () => {
    const baseline = { [PLOTS]: { frameP95Ms: 2, intervalP95Ms: 16.7 }, [SESSION]: { p95: 1 } };
    const verdict = compareWithBaseline({ [PLOTS]: { frameP95Ms: 2 } }, baseline);
    expect(verdict.failed).toBe(true);
    expect(verdict.lines).toEqual(
      expect.arrayContaining([
        `${PLOTS}: intervalP95Ms is in the baseline but was not measured: FAILED`,
        `${SESSION}: p95 is in the baseline but was not measured: FAILED`,
      ])
    );
  });

  test('fails a measured timing, or a whole test, that has no baseline', () => {
    const verdict = compareWithBaseline(
      { [PLOTS]: { frameP95Ms: 2, intervalP95Ms: 16.7 }, [SESSION]: { p95: 1 } },
      { [PLOTS]: { frameP95Ms: 2 } }
    );
    expect(verdict.failed).toBe(true);
    expect(verdict.lines).toEqual(
      expect.arrayContaining([
        `${PLOTS}: intervalP95Ms 16.70 ms has no baseline: FAILED`,
        `${SESSION}: p95 1.00 ms has no baseline: FAILED`,
      ])
    );
  });
});

describe('checkBudgets', () => {
  test('passes a timing within its absolute budget, whatever the baseline', () => {
    expect(checkBudgets(new Map([[PLOTS, budgeted(8)]])).failed).toBe(false);
  });

  test('fails a timing over its budget, and a budget with no timing', () => {
    expect(checkBudgets(new Map([[PLOTS, budgeted(8.1)]])).failed).toBe(true);
    const unmeasured: BenchResult = { timings: {}, budgets: { frameP95Ms: 8 }, summary: '' };
    expect(checkBudgets(new Map([[PLOTS, unmeasured]])).failed).toBe(true);
  });
});

describe('records', () => {
  test('rounds timings to hundredths and are read back', () => {
    const tests = timingsOf(new Map([[PLOTS, { timings: { frameP95Ms: 2.3456 }, summary: '' }]]));
    expect(tests).toEqual({ [PLOTS]: { frameP95Ms: 2.35 } });
    expect(isBenchRecord({ recorded: '2026-09-29', machine: 'host', tests })).toBe(true);
    expect(
      isBenchRecord({ recorded: '2026-09-29', machine: 'host', tests: { x: { y: 'z' } } })
    ).toBe(false);
  });
});

describe('compareWithBaseline against another run', () => {
  test('notes the tests and timings only one side has, without failing', () => {
    const verdict = compareWithBaseline(
      { [PLOTS]: { frameP95Ms: 2, added: 1 }, renamed: { p95: 1 } },
      { [PLOTS]: { frameP95Ms: 2, removed: 1 }, [SESSION]: { p95: 1 } },
      'shared'
    );
    expect(verdict.failed).toBe(false);
    expect(verdict.lines).toEqual(
      expect.arrayContaining([
        `${PLOTS}: added 1.00 ms has no baseline: notice`,
        'renamed: p95 1.00 ms has no baseline: notice',
        `${PLOTS}: removed is in the baseline but was not measured: notice`,
        `${SESSION}: p95 is in the baseline but was not measured: notice`,
      ])
    );
  });

  test('fails when the head shares no timing with the base', () => {
    const verdict = compareWithBaseline({}, { [PLOTS]: { frameP95Ms: 2 } }, 'shared');
    expect(verdict.failed).toBe(true);
    expect(verdict.lines).toContain('No timing was measured on both sides: FAILED');
  });

  test('still fails a timing both sides measured that regressed', () => {
    const verdict = compareWithBaseline(
      { [PLOTS]: { frameP95Ms: 3.6 }, added: { p95: 1 } },
      { [PLOTS]: { frameP95Ms: 2 } },
      'shared'
    );
    expect(verdict.failed).toBe(true);
    expect(verdict.lines.join('\n')).toContain('REGRESSED');
  });
});

describe('bestOf', () => {
  test('keeps each timing at its lowest over the runs that measured it', () => {
    expect(
      bestOf([
        { [PLOTS]: { frameP95Ms: 2.4 }, [SESSION]: { p95: 1 } },
        { [PLOTS]: { frameP95Ms: 2.1, other: 3 } },
      ])
    ).toEqual({ [PLOTS]: { frameP95Ms: 2.1, other: 3 }, [SESSION]: { p95: 1 } });
  });
});
