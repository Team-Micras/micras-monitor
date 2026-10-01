import { Emitter, type Listener, type Unsubscribe } from '@/core/emitter';

import type { Epoch } from '../link/epochs';
import type { GroupRequest } from '../link/group-configurator';
import { RobotError, LinkError } from '../link/errors';
import type { LinkCounters, SampleEvent } from '../link/link-events';
import type { RobotLink } from '../link/robot-link';
import {
  BandwidthEstimator,
  type BudgetEstimate,
  type BandwidthEstimatorOptions,
  type DropCounter,
} from './bandwidth-estimator';
import { fitGroups, type PlannedRate, type RateRequest, type StreamPlan } from './fit-groups';

/** The part of a {@link RobotLink} a planner uses. */
export type PlannerLink = Pick<RobotLink, 'on' | 'schema' | 'robot' | 'openEpochs' | 'setGroups'>;

/** How a {@link StreamPlanner} plans. */
export interface StreamPlannerOptions {
  /** How long, in milliseconds, requests have to stay the same before they are planned. */
  debounceMs?: number;
  /** How much the budget has to grow, as a share, before a plan that was cut is made again. */
  growthToReplan?: number;
  /**
   * How far, as a share of the budget, a plan may go over a budget that shrank before it is made
   * again; samples dropping for want of room make it again at once.
   */
  overspendToReplan?: number;
  /**
   * How long, in milliseconds, the budget has to stay past what the plan was made for before a
   * plan that fits or was cut is made again; the share of unmetered traffic, such as the answers
   * to reads, moves the budget back and forth from one update to the next. Samples dropping, or
   * the ceiling of the link moving, make the plan again at once.
   */
  settleMs?: number;
  /** How the budget is estimated. */
  budget?: Partial<BandwidthEstimatorOptions>;
  /** How long, in milliseconds, to wait before planning again after the robot refused a plan. */
  retryMs?: number;
  /** The current time in milliseconds; `performance.now` by default. */
  now?: () => number;
}

/** What a stream planner emits. */
export interface StreamPlannerEvents {
  /** A new plan, applied or about to be. */
  plan: StreamPlan;
  /** The robot refused a plan, or it got no answer; the planner tries again after a while. */
  error: Error;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_GROWTH_TO_REPLAN = 0.2;
const DEFAULT_OVERSPEND_TO_REPLAN = 0.1;
const DEFAULT_RETRY_MS = 2000;
const DEFAULT_SETTLE_MS = 3000;
const MAX_RETRY_MS = 30_000;

function sameRequests(a: readonly RateRequest[], b: readonly RateRequest[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (request, index) =>
        request.variable === b[index].variable &&
        request.rateHz === b[index].rateHz &&
        request.pinned === b[index].pinned &&
        request.countsDrops === b[index].countsDrops
    )
  );
}

function isLinkChange(error: unknown): boolean {
  return (
    error instanceof LinkError &&
    (error.reason === 'restarted' ||
      error.reason === 'disconnected' ||
      error.reason === 'closed' ||
      error.reason === 'superseded')
  );
}

function sameGroups(a: readonly GroupRequest[], b: readonly GroupRequest[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (group, index) =>
        group.periodTicks === b[index].periodTicks &&
        group.variableIds.length === b[index].variableIds.length &&
        group.variableIds.every((id, at) => id === b[index].variableIds[at])
    )
  );
}

/**
 * Decides what a link streams: the variables asked for, grouped by rate and fitted into the
 * budget the link measurably carries, applied with `setGroups`.
 *
 * Requests are planned once they have been left alone for a moment, so a burst of layout changes
 * reconfigures the robot once, and requests equal to the last ones change nothing. The budget is
 * estimated again with every stats event of the link, from the robot's own count of dropped
 * samples when a request says which variable holds it. A plan is made again at once when the
 * ceiling of the link moved under a plan it bounds, as samples dropping move it; samples that
 * keep dropping while the robot gets that plan move nothing, so they do not make it again. A
 * plan that no longer fits, or one that was cut while the budget grew enough to be worth a
 * reconfiguration, is made again only once the budget stayed there a while, since the share of
 * unmetered traffic moves it back and forth. The robot is only reconfigured when the groups
 * change.
 *
 * A plan the robot refuses is made again after a backoff, without the variables that did not
 * make it into a streaming group, which it reports as not granted until the schema changes.
 */
export class StreamPlanner {
  readonly #link: PlannerLink;
  readonly #events = new Emitter<StreamPlannerEvents>();
  readonly #estimator: BandwidthEstimator;
  readonly #debounceMs: number;
  readonly #growthToReplan: number;
  readonly #overspendToReplan: number;
  readonly #retryMs: number;
  readonly #settleMs: number;
  readonly #now: () => number;
  readonly #detach: Unsubscribe[];
  readonly #dropCounters = new Map<number, { readonly index: number; readonly periodMs: number }>();
  readonly #refused = new Set<string>();
  #requests: readonly RateRequest[] = [];
  #current: StreamPlan | undefined;
  #applied: readonly GroupRequest[] | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  #dropCounter: DropCounter | undefined;
  #driftingSince: number | undefined;
  #closed = false;

  /**
   * @param link The link whose groups the planner owns.
   * @param options How to plan.
   */
  constructor(link: PlannerLink, options: StreamPlannerOptions = {}) {
    this.#link = link;
    this.#estimator = new BandwidthEstimator(options.budget);
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#growthToReplan = options.growthToReplan ?? DEFAULT_GROWTH_TO_REPLAN;
    this.#overspendToReplan = options.overspendToReplan ?? DEFAULT_OVERSPEND_TO_REPLAN;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#now = options.now ?? (() => performance.now());
    this.#detach = [
      link.on('schema', () => {
        this.#applied = undefined;
        this.#refused.clear();
        this.#failures = 0;
        this.#planSoon();
      }),
      link.on('stats', (stats) => this.#onStats(stats)),
      link.on('epoch', (epoch) => this.#onEpoch(epoch)),
      link.on('epochEnd', ({ epoch }) => this.#onEpochEnd(epoch)),
      link.on('sample', (sample) => this.#onSample(sample)),
    ];
  }

  /** The latest plan, or undefined before the schema is known. */
  get plan(): StreamPlan | undefined {
    return this.#current;
  }

  /** The latest estimate of what the link carries. */
  get budget(): BudgetEstimate {
    return this.#estimator.value;
  }

  /**
   * Listen to an event.
   *
   * @returns A function that removes the listener.
   */
  on<K extends keyof StreamPlannerEvents>(
    event: K,
    listener: Listener<StreamPlannerEvents[K]>
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  /**
   * Replace what is asked for. It is planned once no other request came for the debounce time.
   *
   * @param requests Every variable wanted, with its rate and whether it is pinned.
   */
  request(requests: readonly RateRequest[]): void {
    if (sameRequests(this.#requests, requests)) {
      return;
    }

    this.#requests = requests;
    this.#planSoon();
  }

  /** Plan what is asked for now, without waiting. */
  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#replan();
  }

  /** Stop planning. The link keeps the groups it has. */
  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#retryTimer);
    this.#detach.forEach((unsubscribe) => unsubscribe());
  }

  #planSoon(): void {
    if (this.#closed) {
      return;
    }

    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), this.#debounceMs);
  }

  #onEpoch(epoch: Epoch): void {
    const counter = this.#requests.find((request) => request.countsDrops === true)?.variable;
    const id = this.#link.schema?.find((entry) => entry.name === counter)?.id;
    const index = id === undefined ? -1 : epoch.variableIds.indexOf(id);

    if (index >= 0) {
      const periodMs = (epoch.periodTicks * (this.#link.robot?.loopTimeUs ?? 0)) / 1000;
      this.#dropCounters.set(epoch.id, { index, periodMs });
    }
  }

  #onEpochEnd(epoch: Epoch): void {
    if (this.#dropCounters.delete(epoch.id)) {
      this.#dropCounter = undefined;
    }
  }

  #onSample(sample: SampleEvent): void {
    const counter = this.#dropCounters.get(sample.epoch);

    if (counter !== undefined) {
      this.#dropCounter = {
        count: Number(sample.values[counter.index]),
        periodMs: counter.periodMs,
      };
    }
  }

  #onStats(stats: LinkCounters): void {
    const window = this.#link.robot?.creditWindow ?? 0;
    const plan = this.#current;
    const revision = this.#estimator.value.revision;
    const now = this.#now();
    const estimate = this.#estimator.update(
      stats,
      window,
      now,
      plan?.overBudget === true,
      this.#dropCounter
    );

    if (!plan || this.#timer !== undefined) {
      return;
    }

    const overspent =
      plan.usedBytesPerSecond > estimate.bytesPerSecond * (1 + this.#overspendToReplan);
    const ceilingMoved =
      estimate.revision !== revision &&
      (plan.overBudget || plan.usedBytesPerSecond > estimate.bytesPerSecond);

    if (this.#retryTimer !== undefined) {
      if (ceilingMoved || this.#settled(overspent, now)) {
        clearTimeout(this.#retryTimer);
        this.#retryTimer = undefined;
        this.#replan();
      }

      return;
    }

    const roomToGrow =
      plan.overBudget &&
      estimate.bytesPerSecond > plan.budgetBytesPerSecond * (1 + this.#growthToReplan);

    if (ceilingMoved || this.#settled(overspent || roomToGrow, now)) {
      this.#replan();
    }
  }

  /** Whether the budget has been past the plan, without a break, for the settle time. */
  #settled(drifting: boolean, now: number): boolean {
    if (!drifting) {
      this.#driftingSince = undefined;
      return false;
    }

    this.#driftingSince ??= now;
    return now - this.#driftingSince >= this.#settleMs;
  }

  #replan(): void {
    const schema = this.#link.schema;
    const robot = this.#link.robot;

    if (this.#closed || !schema || !robot) {
      return;
    }

    const planned = fitGroups({
      schema,
      loopTimeUs: robot.loopTimeUs,
      requests: this.#requests.filter((request) => !this.#refused.has(request.variable)),
      budgetBytesPerSecond: this.#estimator.value.bytesPerSecond,
    });
    const plan = this.#withRefused(planned);

    this.#current = plan;
    this.#driftingSince = undefined;
    this.#events.emit('plan', plan);

    if (this.#applied && sameGroups(this.#applied, plan.groups)) {
      return;
    }

    const groups = plan.groups;
    this.#applied = groups;
    this.#link.setGroups(groups).then(
      (result) => {
        if (result.status === 'applied' && this.#applied === groups) {
          this.#failures = 0;
        }
      },
      (error: unknown) => this.#onRefused(groups, error)
    );
  }

  #withRefused(plan: StreamPlan): StreamPlan {
    if (this.#refused.size === 0) {
      return plan;
    }

    const refused: PlannedRate[] = this.#requests
      .filter((request) => this.#refused.has(request.variable))
      .map((request) => ({
        variable: request.variable,
        rateHz: request.rateHz,
        grantedHz: 0,
        pinned: request.pinned === true,
      }));
    const unique = refused.filter(
      (rate, index) => refused.findIndex((other) => other.variable === rate.variable) === index
    );

    return { ...plan, rates: [...plan.rates, ...unique] };
  }

  #onRefused(groups: readonly GroupRequest[], error: unknown): void {
    if (this.#closed || this.#applied !== groups || isLinkChange(error)) {
      return;
    }

    this.#applied = undefined;

    if (error instanceof RobotError) {
      this.#markRefused(groups);
    }

    this.#events.emit('error', error instanceof Error ? error : new Error(String(error)));
    const wait = Math.min(MAX_RETRY_MS, this.#retryMs * 2 ** this.#failures);
    this.#failures++;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#replan();
    }, wait);
  }

  #markRefused(groups: readonly GroupRequest[]): void {
    const schema = this.#link.schema;
    const streaming = new Set(this.#link.openEpochs.flatMap((epoch) => epoch.variableIds));

    for (const id of groups.flatMap((group) => group.variableIds)) {
      const name = schema?.[id]?.name;

      if (name !== undefined && !streaming.has(id)) {
        this.#refused.add(name);
      }
    }
  }
}
