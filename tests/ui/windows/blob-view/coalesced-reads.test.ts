import { describe, expect, test } from 'vitest';

import { CoalescedReads } from '@/ui/windows/blob-view/coalesced-reads';

function deferredReads() {
  const answers: (() => void)[] = [];
  const reads = new CoalescedReads(
    () =>
      new Promise<void>((resolve) => {
        answers.push(resolve);
      })
  );
  return { reads, answers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CoalescedReads', () => {
  test('keeps one read in flight and reads once more for every burst of requests', async () => {
    const { reads, answers } = deferredReads();
    reads.request();
    reads.request();
    reads.request();
    expect(answers).toHaveLength(1);

    answers[0]();
    await settle();
    expect(answers).toHaveLength(2);

    answers[1]();
    await settle();
    expect(answers).toHaveLength(2);
  });

  test('reads nothing once closed', async () => {
    const { reads, answers } = deferredReads();
    reads.request();
    reads.request();
    reads.close();
    answers[0]();
    await settle();
    reads.request();
    expect(answers).toHaveLength(1);
  });
});
