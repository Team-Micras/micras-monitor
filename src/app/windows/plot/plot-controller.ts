/**
 * A uPlot chart driven straight from the history: it redraws when the store says its variables
 * changed, at most once per frame, and React only creates and configures it.
 *
 * @module
 */

import uPlot from 'uplot';

import { formatClock } from '../../lib/format';
import type { HistoryPort, TimeRange } from '../../ports';
import {
  followWindow,
  layoutAxes,
  PlotData,
  toMicroseconds,
  toSeconds,
  visibleGaps,
  type GapSpan,
  type PlotVariable,
} from './plot-data';

/** The colors and font a plot draws with, read from the theme. */
export interface PlotTheme {
  readonly axis: string;
  readonly grid: string;
  readonly dropped: string;
  readonly notStored: string;
  readonly font: string;
}

/** What a plot shows besides its lines, for the window to draw around it. */
export interface PlotStatus {
  /** None of the variables has a sample yet. */
  readonly empty: boolean;
  /** Samples lost in the window. */
  readonly dropped: number;
  /** Samples not kept in the window. */
  readonly notStored: number;
}

/** How to set up a plot. */
export interface PlotControllerOptions {
  readonly history: HistoryPort;
  readonly variables: readonly PlotVariable[];
  /** How long the live window is. */
  readonly spanUs: number;
  readonly theme: PlotTheme;
  /** Plots with the same key move their cursors together. */
  readonly syncKey: string;
  /** Hears about the status when it changes. */
  readonly onStatus?: (status: PlotStatus) => void;
  /** Hears how long each redraw took, in milliseconds. */
  readonly onDraw?: (milliseconds: number) => void;
}

interface Tooltip {
  readonly element: HTMLDivElement;
  readonly time: HTMLDivElement;
  readonly values: readonly HTMLSpanElement[];
}

const GAP_ALPHA = 0.14;
const LABEL_CHAR_PX = 6.7;
const AXIS_PADDING_PX = 14;
const MIN_COLUMNS = 2;

function sameStatus(left: PlotStatus, right: PlotStatus): boolean {
  return (
    left.empty === right.empty &&
    left.dropped === right.dropped &&
    left.notStored === right.notStored
  );
}

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

/** A plot of some variables over time, in a DOM element it owns. */
export class PlotController {
  readonly #options: PlotControllerOptions;
  readonly #names: readonly string[];
  readonly #data: PlotData;
  readonly #plot: uPlot;
  readonly #tooltip: Tooltip;
  readonly #unsubscribe: () => void;
  #spanUs: number;
  #paused = false;
  #hovered = false;
  #window: TimeRange | undefined;
  #spans: readonly GapSpan[] = [];
  #status: PlotStatus = { empty: true, dropped: 0, notStored: 0 };

  /**
   * @param root The element the chart fills; its size is the chart's until {@link resize}.
   * @param options The variables, the history and the look.
   */
  constructor(root: HTMLElement, options: PlotControllerOptions) {
    this.#options = options;
    this.#names = options.variables.map((variable) => variable.name);
    this.#data = new PlotData(options.history);
    this.#spanUs = options.spanUs;
    this.#tooltip = this.#createTooltip(root);
    this.#plot = new uPlot(this.#config(root), [[]], root);
    this.#plot.over.addEventListener('pointerenter', this.#enter);
    this.#plot.over.addEventListener('pointerleave', this.#leave);
    this.#unsubscribe = options.history.subscribe(this.#names, () => {
      if (!this.#paused) {
        this.draw();
      }
    });
    this.draw();
  }

  /** Freezes the window where it is, or follows the newest samples again. */
  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.draw();
  }

  /** Changes how long the live window is. */
  setSpan(spanUs: number): void {
    this.#spanUs = spanUs;

    if (!this.#paused) {
      this.draw();
    }
  }

  /** Fits the chart to a new size, in CSS pixels. */
  resize(width: number, height: number): void {
    this.#plot.setSize({ width: Math.max(1, width), height: Math.max(1, height) });
    this.draw();
  }

  /** Draws the current window again from the history. */
  draw(): void {
    const started = performance.now();
    const columns = Math.max(MIN_COLUMNS, Math.round(this.#plot.bbox.width / devicePixelRatio));

    if (!this.#paused || this.#window === undefined) {
      this.#window = followWindow(this.#options.history, this.#names, this.#spanUs, columns);
    }

    const window = this.#window;

    if (window === undefined) {
      this.#spans = [];
      this.#plot.batch(() => this.#plot.setData([[], ...this.#names.map(() => [])]));
      this.#setStatus({ empty: true, dropped: 0, notStored: 0 });
      return;
    }

    const gaps = visibleGaps(this.#options.history, this.#names, window);
    this.#spans = gaps.spans;
    this.#plot.batch(() => this.#plot.setData(this.#data.build(this.#names, window, columns)));
    this.#setStatus({ empty: false, dropped: gaps.dropped, notStored: gaps.notStored });
    this.#options.onDraw?.(performance.now() - started);
  }

  /** Stops following the history and removes the chart. */
  destroy(): void {
    this.#unsubscribe();
    this.#plot.over.removeEventListener('pointerenter', this.#enter);
    this.#plot.over.removeEventListener('pointerleave', this.#leave);
    this.#plot.destroy();
    this.#tooltip.element.remove();
  }

  #config(root: HTMLElement): uPlot.Options {
    const { variables, theme, syncKey } = this.#options;
    const layout = layoutAxes(variables);
    const scales: uPlot.Scales = {
      x: { time: false, range: () => this.#xRange() },
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
        drawAxes: [(plot) => this.#drawGaps(plot)],
        setCursor: [(plot) => this.#updateTooltip(plot)],
      },
    };
  }

  #xRange(): uPlot.Range.MinMax {
    const window = this.#window;
    return window === undefined ? [0, 1] : [toSeconds(window.startUs), toSeconds(window.endUs)];
  }

  #drawGaps(plot: uPlot): void {
    if (this.#spans.length === 0) {
      return;
    }

    const { ctx, bbox } = plot;
    const { theme } = this.#options;
    ctx.save();
    ctx.globalAlpha = GAP_ALPHA;

    for (const span of this.#spans) {
      const left = plot.valToPos(toSeconds(span.startUs), 'x', true);
      const right = plot.valToPos(toSeconds(span.endUs), 'x', true);
      ctx.fillStyle = span.kind === 'dropped' ? theme.dropped : theme.notStored;
      ctx.fillRect(left, bbox.top, Math.max(devicePixelRatio, right - left), bbox.height);
    }

    ctx.restore();
  }

  #createTooltip(root: HTMLElement): Tooltip {
    const element = document.createElement('div');
    element.dataset.plotTooltip = '';
    element.className =
      'pointer-events-none absolute z-10 hidden min-w-48 rounded-lg border bg-popover px-3 py-2 font-mono text-xs text-popover-foreground shadow-md';
    const time = document.createElement('div');
    time.className = 'mb-1 tabular-nums';
    element.append(time);
    const values = this.#options.variables.map((variable) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2';
      const swatch = document.createElement('span');
      swatch.className = 'size-2 shrink-0 rounded-[2px]';
      swatch.style.background = variable.color;
      const name = document.createElement('span');
      name.className = 'flex-1 truncate text-muted-foreground';
      name.textContent = variable.name;
      const value = document.createElement('span');
      value.className = 'tabular-nums';
      row.append(swatch, name, value);
      element.append(row);
      return value;
    });
    root.append(element);
    return { element, time, values };
  }

  #updateTooltip(plot: uPlot): void {
    const left = plot.cursor.left ?? -1;
    const { element, time, values } = this.#tooltip;

    if (!this.#hovered || left < 0 || this.#window === undefined) {
      element.classList.add('hidden');
      return;
    }

    const seconds = plot.posToVal(left, 'x');
    const timeUs = toMicroseconds(seconds);
    time.textContent = `t ${formatClock(seconds * 1000)}`;
    this.#options.variables.forEach((variable, index) => {
      const sample = this.#options.history.valueAt(variable.name, timeUs);
      values[index].textContent =
        sample === undefined || Number.isNaN(sample.value) ? '—' : sample.value.toFixed(3);
    });
    element.classList.remove('hidden');
    const over = plot.over.getBoundingClientRect();
    const root = plot.root.getBoundingClientRect();
    const width = element.offsetWidth;
    const x = left + 12 + width > over.width ? left - width - 12 : left + 12;
    element.style.left = `${over.left - root.left + x}px`;
    element.style.top = `${over.top - root.top + 8}px`;
  }

  #setStatus(status: PlotStatus): void {
    if (!sameStatus(status, this.#status)) {
      this.#status = status;
      this.#options.onStatus?.(status);
    }
  }

  readonly #enter = () => {
    this.#hovered = true;
  };

  readonly #leave = () => {
    this.#hovered = false;
    this.#tooltip.element.classList.add('hidden');
  };
}
