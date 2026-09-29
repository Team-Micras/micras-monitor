/**
 * Waiting for the page to stop moving, for tests that measure or click what an animation places.
 *
 * @module
 */

/** Resolves once the next frame has started every animation and each finite one has finished. */
export async function settled(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined))
  );
}
