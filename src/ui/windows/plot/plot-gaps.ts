/**
 * The bands a plot draws where its samples were lost or not kept, behind the lines.
 *
 * @module
 */

import type uPlot from 'uplot';

import type { PlotTheme } from './plot-config';
import { toSeconds, type GapSpan } from './plot-data';

const GAP_ALPHA = 0.14;

/** Shades the spans of a plot with no samples, in the color of why they are missing. */
export function drawGaps(plot: uPlot, spans: readonly GapSpan[], theme: PlotTheme): void {
  if (spans.length === 0) {
    return;
  }

  const { ctx, bbox } = plot;
  ctx.save();
  ctx.globalAlpha = GAP_ALPHA;

  for (const span of spans) {
    const left = plot.valToPos(toSeconds(span.startUs), 'x', true);
    const right = plot.valToPos(toSeconds(span.endUs), 'x', true);
    ctx.fillStyle = span.kind === 'dropped' ? theme.dropped : theme.notStored;
    ctx.fillRect(left, bbox.top, Math.max(devicePixelRatio, right - left), bbox.height);
  }

  ctx.restore();
}
