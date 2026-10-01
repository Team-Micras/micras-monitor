/**
 * The tooltip of a plot: the time under the cursor and the value of each variable then.
 *
 * @module
 */

import type uPlot from 'uplot';

import type { HistoryStore } from '@/history';

import { formatClock } from '../../lib/format';
import { toMicroseconds, type PlotVariable } from './plot-data';

/** A tooltip over a plot, in an element it adds to the plot's root. */
export class PlotTooltip {
  readonly #history: HistoryStore;
  readonly #variables: readonly PlotVariable[];
  readonly #element: HTMLDivElement;
  readonly #time: HTMLDivElement;
  readonly #values: readonly HTMLSpanElement[];

  /**
   * @param root Where the tooltip is added.
   * @param variables The variables it shows, in their colors.
   * @param history Where their values are read.
   */
  constructor(root: HTMLElement, variables: readonly PlotVariable[], history: HistoryStore) {
    this.#history = history;
    this.#variables = variables;
    this.#element = document.createElement('div');
    this.#element.dataset.plotTooltip = '';
    this.#element.className =
      'pointer-events-none absolute z-10 hidden min-w-48 rounded-lg border bg-popover px-3 py-2 font-mono text-xs text-popover-foreground shadow-md';
    this.#time = document.createElement('div');
    this.#time.className = 'mb-1 tabular-nums';
    this.#element.append(this.#time);
    this.#values = variables.map((variable) => {
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
      this.#element.append(row);
      return value;
    });
    root.append(this.#element);
  }

  /** Shows the values at the plot's cursor next to it, or hides when the cursor is off the plot. */
  show(plot: uPlot): void {
    const left = plot.cursor.left ?? -1;

    if (left < 0) {
      this.hide();
      return;
    }

    const seconds = plot.posToVal(left, 'x');
    const timeUs = toMicroseconds(seconds);
    this.#time.textContent = `t ${formatClock(seconds * 1000)}`;
    this.#variables.forEach((variable, index) => {
      const sample = this.#history.valueAt(variable.name, timeUs);
      this.#values[index].textContent =
        sample === undefined || Number.isNaN(sample.value) ? '—' : sample.value.toFixed(3);
    });
    this.#element.classList.remove('hidden');
    const over = plot.over.getBoundingClientRect();
    const root = plot.root.getBoundingClientRect();
    const width = this.#element.offsetWidth;
    const x = left + 12 + width > over.width ? left - width - 12 : left + 12;
    this.#element.style.left = `${over.left - root.left + x}px`;
    this.#element.style.top = `${over.top - root.top + 8}px`;
  }

  /** Hides the tooltip until it is shown again. */
  hide(): void {
    this.#element.classList.add('hidden');
  }

  /** Takes the tooltip out of the page. */
  remove(): void {
    this.#element.remove();
  }
}
