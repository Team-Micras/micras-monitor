/**
 * The uPlot options of a plot: its series, one time axis and the value axes its variables share,
 * in the colors and font of the theme, and the bands it draws behind the lines where samples were
 * lost or not kept.
 *
 * @module
 */

import type uPlot from 'uplot';

import { formatClock } from '../../lib/format';
import { layoutAxes, toSeconds, type GapSpan, type PlotVariable } from './plot-data';

/** The colors and font a plot draws with, read from the theme. */
export interface PlotTheme {
  readonly axis: string;
  readonly grid: string;
  readonly dropped: string;
  readonly notStored: string;
  readonly font: string;
}

/** What a plot's options are built from. */
export interface PlotConfigOptions {
  /** The element the chart fills, whose size it starts at. */
  readonly root: HTMLElement;
  readonly variables: readonly PlotVariable[];
  readonly theme: PlotTheme;
  /** Plots with the same key move their cursors together. */
  readonly syncKey: string;
  /** The time window to show, in seconds. */
  readonly xRange: () => uPlot.Range.MinMax;
  /** Draws under the lines, after the axes. */
  readonly drawAxes: (plot: uPlot) => void;
  /** Hears that the cursor moved. */
  readonly setCursor: (plot: uPlot) => void;
}

const LABEL_CHAR_PX = 6.7;
const AXIS_PADDING_PX = 14;
const GAP_ALPHA = 0.14;

function timeLabels(splits: number[], increment: number): string[] {
  return splits.map((seconds) => {
    if (seconds < 0) {
      return '';
    }

    const clock = formatClock(seconds * 1000);
    return increment >= 1 ? clock.slice(0, -2) : clock;
  });
}

function axisWidth(values: readonly string[] | null): number {
  const longest = values?.reduce((width, value) => Math.max(width, value.length), 0) ?? 4;
  return Math.ceil(longest * LABEL_CHAR_PX) + AXIS_PADDING_PX;
}

function valueLabels(splits: number[], increment: number): string[] {
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(increment))));
  return splits.map((value) => value.toFixed(decimals));
}

/** The uPlot options of a plot of some variables over time. */
export function plotConfig({
  root,
  variables,
  theme,
  syncKey,
  xRange,
  drawAxes,
  setCursor,
}: PlotConfigOptions): uPlot.Options {
  const layout = layoutAxes(variables);
  const scales: uPlot.Scales = {
    x: { time: false, range: xRange },
  };

  for (const axis of layout.axes) {
    scales[axis.scale] = { auto: true };
  }

  return {
    width: Math.max(1, root.clientWidth),
    height: Math.max(1, root.clientHeight),
    pxAlign: 1,
    legend: { show: false },
    cursor: {
      sync: { key: syncKey, setSeries: false },
      points: { show: false },
      drag: { x: false, y: false },
      y: false,
    },
    scales,
    series: [
      {},
      ...variables.map((variable, index) => ({
        label: variable.name,
        stroke: variable.color,
        width: 1,
        scale: layout.scales[index],
        spanGaps: false,
        points: { show: false },
      })),
    ],
    axes: [
      {
        stroke: theme.axis,
        font: theme.font,
        grid: { show: false },
        ticks: { show: false },
        gap: 6,
        size: 28,
        space: 80,
        values: (_plot, splits, _index, _space, increment) => timeLabels(splits, increment),
      },
      ...layout.axes.map((axis, index) => ({
        scale: axis.scale,
        side: axis.side === 'left' ? 3 : 1,
        stroke: theme.axis,
        font: theme.font,
        grid: { show: index === 0, stroke: theme.grid, width: 1 },
        ticks: { show: false },
        gap: 6,
        size: (_plot: uPlot, values: string[] | null) => axisWidth(values),
        space: 36,
        values: (
          _plot: uPlot,
          splits: number[],
          _index: number,
          _space: number,
          increment: number
        ) => valueLabels(splits, increment),
      })),
    ],
    hooks: {
      drawAxes: [drawAxes],
      setCursor: [setCursor],
    },
  };
}

/** What of a uPlot chart its gap bands are drawn with. */
export interface GapCanvas {
  readonly ctx: Pick<
    CanvasRenderingContext2D,
    'save' | 'restore' | 'fillRect' | 'fillStyle' | 'globalAlpha'
  >;
  readonly bbox: Pick<uPlot.BBox, 'top' | 'height'>;
  readonly valToPos: uPlot['valToPos'];
}

/** Shades the spans of a plot with no samples, in the color of why they are missing. */
export function drawGaps(plot: GapCanvas, spans: readonly GapSpan[], theme: PlotTheme): void {
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
