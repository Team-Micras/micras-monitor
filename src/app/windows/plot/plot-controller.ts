/**
 * A uPlot chart driven straight from the history: it redraws when the store says its variables
 * changed, at most once per frame, and React only creates and configures it.
 *
 * @module
 */

import uPlot from 'uplot';

import type { HistoryMark, TelemetryStore, TimeRange } from '@/telemetry';

import { formatClock } from '../../lib/format';
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
import {
  historyBounds,
  PAN_STEP,
  panWindow,
  wholeHistory,
  ZOOM_STEP,
  zoomWindow,
} from './plot-navigation';

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
  readonly history: TelemetryStore;
  readonly variables: readonly PlotVariable[];
  /** How long the live window is. */
  readonly spanUs: number;
  readonly theme: PlotTheme;
  /** Plots with the same key move their cursors together. */
  readonly syncKey: string;
  /** Where the keys that move the window are listened for, such as the window's frame; the root by default. */
  readonly keys?: HTMLElement;
  /** Hears about the status when it changes. */
  readonly onStatus?: (status: PlotStatus) => void;
  /** Hears how long each redraw took, in milliseconds, and the window it drew. */
  readonly onDraw?: (milliseconds: number, window: TimeRange) => void;
  /**
   * Hears that the user moved the window back in time or zoomed it, which pauses the plot where
   * it is: the window then pauses it in the shell too.
   */
  readonly onNavigate?: () => void;
  /** Hears that the user asked to follow the live end again. */
  readonly onResume?: () => void;
}

interface Tooltip {
  readonly element: HTMLDivElement;
  readonly time: HTMLDivElement;
  readonly values: readonly HTMLSpanElement[];
}

interface Drag {
  readonly pointerId: number;
  readonly x: number;
  readonly window: TimeRange;
  moved: boolean;
}

const GAP_ALPHA = 0.14;
const WHEEL_ZOOM_PER_PIXEL = 0.002;
const WHEEL_LINE_PIXELS = 16;
const DRAG_THRESHOLD_PX = 3;
const LABEL_CHAR_PX = 6.7;
const AXIS_PADDING_PX = 14;
const MIN_COLUMNS = 2;

function sameStatus(left: PlotStatus | null, right: PlotStatus): boolean {
  return (
    left !== null &&
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
  readonly #root: HTMLElement;
  readonly #data: PlotData;
  #variables: readonly PlotVariable[];
  #theme: PlotTheme;
  #names: readonly string[];
  #plot: uPlot;
  #tooltip: Tooltip;
  #unsubscribe: () => void;
  #spanUs: number;
  #paused = false;
  #visible = true;
  #hovered = false;
  #window: TimeRange | undefined;
  #spans: readonly GapSpan[] = [];
  #status: PlotStatus | null = null;
  #marks: readonly (HistoryMark | undefined)[] = [];
  readonly #keys: HTMLElement;
  #drag: Drag | null = null;

  /**
   * @param root The element the chart fills; its size is the chart's until {@link resize}.
   * @param options The variables, the history and the look.
   */
  constructor(root: HTMLElement, options: PlotControllerOptions) {
    this.#options = options;
    this.#root = root;
    this.#keys = options.keys ?? root;
    this.#data = new PlotData(options.history);
    this.#spanUs = options.spanUs;
    this.#variables = options.variables;
    this.#theme = options.theme;
    this.#names = options.variables.map((variable) => variable.name);
    this.#tooltip = this.#createTooltip();
    this.#plot = this.#createPlot();
    this.#unsubscribe = this.#follow();
    this.#keys.addEventListener('keydown', this.#key);
    this.draw();
  }

  /**
   * Draws other variables, or the same in other colors, keeping the window, the pause and the
   * span, so that a paused plot stays where it was across a change of theme.
   */
  restyle(variables: readonly PlotVariable[], theme: PlotTheme): void {
    this.#unmount();
    this.#variables = variables;
    this.#theme = theme;
    this.#names = variables.map((variable) => variable.name);
    this.#tooltip = this.#createTooltip();
    this.#plot = this.#createPlot();
    this.#unsubscribe = this.#follow();
    this.draw();
  }

  /** The time window on screen, or undefined before the first sample. */
  get window(): TimeRange | undefined {
    return this.#window;
  }

  /**
   * Freezes the window where it is, or follows the newest samples again.
   *
   * @param paused Whether to freeze it.
   * @param window A window to freeze at instead, such as the one a previous chart of the same
   *   window was frozen at.
   */
  setPaused(paused: boolean, window?: TimeRange): void {
    this.#paused = paused;

    if (paused && window !== undefined) {
      this.#window = window;
    }

    this.draw();
  }

  /** Stops drawing while the chart is off screen, and draws once when it comes back. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
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

  /** Draws the current window again from the history, unless the chart is off screen. */
  draw(): void {
    if (!this.#visible) {
      return;
    }

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

    const { history } = this.#options;
    const gaps = visibleGaps(history, this.#names, window);
    this.#spans = gaps.spans;
    this.#marks = this.#names.map((name) => history.historyMark(name));
    this.#plot.batch(() => this.#plot.setData(this.#data.build(this.#names, window, columns)));
    this.#setStatus({ empty: false, dropped: gaps.dropped, notStored: gaps.notStored });

    this.#options.onDraw?.(performance.now() - started, window);
  }

  /** Shows the whole history, pausing the plot. */
  showWholeHistory(): void {
    const bounds = historyBounds(this.#options.history, this.#names);

    if (bounds !== undefined) {
      this.#moveTo(wholeHistory(bounds));
    }
  }

  /** Stops following the history and removes the chart. */
  destroy(): void {
    this.#keys.removeEventListener('keydown', this.#key);
    this.#unmount();
  }

  #createPlot(): uPlot {
    const plot = new uPlot(this.#config(this.#root), [[]], this.#root);
    const { over } = plot;
    over.style.cursor = 'grab';
    over.style.touchAction = 'none';
    over.addEventListener('pointerenter', this.#enter);
    over.addEventListener('pointerleave', this.#leave);
    over.addEventListener('wheel', this.#wheel, { passive: false });
    over.addEventListener('pointerdown', this.#down);
    over.addEventListener('pointermove', this.#move);
    over.addEventListener('pointerup', this.#up);
    over.addEventListener('pointercancel', this.#up);
    over.addEventListener('dblclick', this.#fit);
    return plot;
  }

  #follow(): () => void {
    return this.#options.history.subscribe(this.#names, () => {
      if (!this.#paused || this.#frozenWindowChanged()) {
        this.draw();
      }
    });
  }

  #frozenWindowChanged(): boolean {
    const window = this.#window;
    const { history } = this.#options;
    return (
      window !== undefined &&
      this.#names.some((name, index) => history.changedSince(name, this.#marks[index], window))
    );
  }

  #unmount(): void {
    this.#unsubscribe();
    this.#hovered = false;
    this.#drag = null;
    const { over } = this.#plot;
    over.removeEventListener('pointerenter', this.#enter);
    over.removeEventListener('pointerleave', this.#leave);
    over.removeEventListener('wheel', this.#wheel);
    over.removeEventListener('pointerdown', this.#down);
    over.removeEventListener('pointermove', this.#move);
    over.removeEventListener('pointerup', this.#up);
    over.removeEventListener('pointercancel', this.#up);
    over.removeEventListener('dblclick', this.#fit);
    this.#plot.destroy();
    this.#tooltip.element.remove();
  }

  #moveTo(window: TimeRange): void {
    this.#window = window;

    if (!this.#paused) {
      this.#paused = true;
      this.#options.onNavigate?.();
    }

    this.draw();
  }

  #spanOf(window: TimeRange): number {
    return window.endUs - window.startUs;
  }

  #pixelsPerMicrosecond(window: TimeRange): number {
    return Math.max(1, this.#plot.over.clientWidth) / Math.max(1, this.#spanOf(window));
  }

  readonly #wheel = (event: WheelEvent) => {
    const window = this.#window;
    const bounds = historyBounds(this.#options.history, this.#names);

    if (window === undefined || bounds === undefined) {
      return;
    }

    event.preventDefault();
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PIXELS : 1;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);

    if (horizontal || event.shiftKey) {
      const pixels = (horizontal ? event.deltaX : event.deltaY) * scale;
      this.#moveTo(panWindow(window, pixels / this.#pixelsPerMicrosecond(window), bounds));
      return;
    }

    const anchorUs = toMicroseconds(this.#plot.posToVal(event.offsetX, 'x'));
    const factor = Math.exp(event.deltaY * scale * WHEEL_ZOOM_PER_PIXEL);
    this.#moveTo(zoomWindow(window, anchorUs, factor, bounds));
  };

  readonly #down = (event: PointerEvent) => {
    const window = this.#window;

    if (event.button !== 0 || window === undefined) {
      return;
    }

    this.#drag = { pointerId: event.pointerId, x: event.clientX, window, moved: false };
    this.#keys.focus({ preventScroll: true });

    try {
      this.#plot.over.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
  };

  readonly #move = (event: PointerEvent) => {
    const drag = this.#drag;
    const bounds = historyBounds(this.#options.history, this.#names);

    if (drag?.pointerId !== event.pointerId || bounds === undefined) {
      return;
    }

    const dx = event.clientX - drag.x;

    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) {
      return;
    }

    drag.moved = true;
    this.#plot.over.style.cursor = 'grabbing';
    const shiftUs = -dx / this.#pixelsPerMicrosecond(drag.window);
    this.#moveTo(panWindow(drag.window, shiftUs, bounds));
  };

  readonly #up = (event: PointerEvent) => {
    if (this.#drag?.pointerId !== event.pointerId) {
      return;
    }

    this.#drag = null;
    this.#plot.over.style.cursor = 'grab';

    if (this.#plot.over.hasPointerCapture(event.pointerId)) {
      this.#plot.over.releasePointerCapture(event.pointerId);
    }
  };

  readonly #fit = () => this.showWholeHistory();

  readonly #key = (event: KeyboardEvent) => {
    const window = this.#window;
    const bounds = historyBounds(this.#options.history, this.#names);

    if (event.altKey || event.ctrlKey || event.metaKey || window === undefined || !bounds) {
      return;
    }

    const span = this.#spanOf(window);
    const middle = window.startUs + span / 2;
    const step = (event.shiftKey ? 5 : 1) * PAN_STEP * span;

    switch (event.key) {
      case 'ArrowLeft':
        this.#moveTo(panWindow(window, -step, bounds));
        break;
      case 'ArrowRight':
        this.#moveTo(panWindow(window, step, bounds));
        break;
      case '+':
      case '=':
        this.#moveTo(zoomWindow(window, middle, 1 / ZOOM_STEP, bounds));
        break;
      case '-':
      case '_':
        this.#moveTo(zoomWindow(window, middle, ZOOM_STEP, bounds));
        break;
      case 'Home':
        this.#moveTo(wholeHistory(bounds));
        break;
      case 'End':
        this.#options.onResume?.();
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  #config(root: HTMLElement): uPlot.Options {
    const variables = this.#variables;
    const theme = this.#theme;
    const { syncKey } = this.#options;
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
    const theme = this.#theme;
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

  #createTooltip(): Tooltip {
    const element = document.createElement('div');
    element.dataset.plotTooltip = '';
    element.className =
      'pointer-events-none absolute z-10 hidden min-w-48 rounded-lg border bg-popover px-3 py-2 font-mono text-xs text-popover-foreground shadow-md';
    const time = document.createElement('div');
    time.className = 'mb-1 tabular-nums';
    element.append(time);
    const values = this.#variables.map((variable) => {
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
    this.#root.append(element);
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
    this.#variables.forEach((variable, index) => {
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
    if (!sameStatus(this.#status, status)) {
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
