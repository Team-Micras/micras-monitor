/**
 * A uPlot chart driven straight from the history: it redraws when the store says its variables
 * changed, at most once per frame, and React only creates and configures it.
 *
 * @module
 */

import uPlot from 'uplot';

import type { HistoryMark, HistoryStore, TimeRange } from '@/history';

import { drawGaps, plotConfig, type PlotTheme } from './plot-config';
import {
  followWindow,
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
import { PlotTooltip } from './plot-tooltip';

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
  readonly history: HistoryStore;
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

interface Drag {
  readonly pointerId: number;
  readonly x: number;
  readonly window: TimeRange;
  moved: boolean;
}

const WHEEL_ZOOM_PER_PIXEL = 0.002;
const WHEEL_LINE_PIXELS = 16;
const DRAG_THRESHOLD_PX = 3;
const MIN_COLUMNS = 2;

function sameStatus(left: PlotStatus | null, right: PlotStatus): boolean {
  return (
    left !== null &&
    left.empty === right.empty &&
    left.dropped === right.dropped &&
    left.notStored === right.notStored
  );
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
  #tooltip: PlotTooltip;
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
    this.#tooltip = new PlotTooltip(this.#root, this.#variables, this.#options.history);
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
    this.#tooltip = new PlotTooltip(this.#root, this.#variables, this.#options.history);
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
    const config = plotConfig({
      root: this.#root,
      variables: this.#variables,
      theme: this.#theme,
      syncKey: this.#options.syncKey,
      xRange: () => this.#xRange(),
      drawAxes: (drawn) => drawGaps(drawn, this.#spans, this.#theme),
      setCursor: (moved) => this.#updateTooltip(moved),
    });
    const plot = new uPlot(config, [[]], this.#root);
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
    this.#tooltip.remove();
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

  #xRange(): uPlot.Range.MinMax {
    const window = this.#window;
    return window === undefined ? [0, 1] : [toSeconds(window.startUs), toSeconds(window.endUs)];
  }

  #updateTooltip(plot: uPlot): void {
    if (this.#hovered && this.#window !== undefined) {
      this.#tooltip.show(plot);
    } else {
      this.#tooltip.hide();
    }
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
    this.#tooltip.hide();
  };
}
