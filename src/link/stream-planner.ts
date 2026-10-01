import { Emitter, type Listener, type Unsubscribe } from '@/core/emitter';

import { RobotError, SessionError } from './errors';
import type { Epoch, GroupRequest } from './groups';
import { LinkBudget, type BudgetEstimate, type LinkBudgetOptions } from './link-budget';
import type { Session } from './session';
import type { LinkStats, SampleEvent } from './session-types';
import { planStreams, type PlannedRate, type RateRequest, type StreamPlan } from './stream-plan';

/** The part of a {@link Session} a planner uses. */
export type PlannerSession = Pick<Session, 'on' | 'schema' | 'robot' | 'openEpochs' | 'setGroups'>;

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
  /** How the budget is estimated. */
  budget?: Partial<LinkBudgetOptions>;
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

function isSessionChange(error: unknown): boolean {
  return (
    error instanceof SessionError &&
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
 * Decides what a session streams: the variables asked for, grouped by rate and fitted into the
 * budget the link measurably carries, applied with `setGroups`.
 *
 * Requests are planned once they have been left alone for a moment, so a burst of layout changes
 * reconfigures the robot once, and requests equal to the last ones change nothing. The budget is
 * estimated again with every stats event of the session, from the robot's own count of dropped
 * samples when a request says which variable holds it. A plan that no longer fits, or that
 * samples drop under, is made again at once; one that was cut is made again when the ceiling
 * of the link moved or the budget grew enough to be worth a reconfiguration. The robot is only
 * reconfigured when the groups change.
 *
 * A plan the robot refuses is made again after a backoff, without the variables that did not
 * make it into a streaming group, which it reports as not granted until the schema changes.
 */
export class StreamPlanner {
  private readonly events = new Emitter<StreamPlannerEvents>();
  private readonly estimator: LinkBudget;
  private readonly debounceMs: number;
  private readonly growthToReplan: number;
  private readonly overspendToReplan: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly detach: Unsubscribe[];
  private readonly dropCounters = new Map<number, number>();
  private readonly refused = new Set<string>();
  private requests: readonly RateRequest[] = [];
  private current: StreamPlan | undefined;
  private applied: readonly GroupRequest[] | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private robotDropped: number | undefined;
  private closed = false;

  /**
   * @param session The session whose groups the planner owns.
   * @param options How to plan.
   */
  constructor(
    private readonly session: PlannerSession,
    options: StreamPlannerOptions = {}
  ) {
    this.estimator = new LinkBudget(options.budget);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.growthToReplan = options.growthToReplan ?? DEFAULT_GROWTH_TO_REPLAN;
    this.overspendToReplan = options.overspendToReplan ?? DEFAULT_OVERSPEND_TO_REPLAN;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.now = options.now ?? (() => performance.now());
    this.detach = [
      session.on('schema', () => {
        this.applied = undefined;
        this.refused.clear();
        this.failures = 0;
        this.planSoon();
      }),
      session.on('stats', (stats) => this.onStats(stats)),
      session.on('epoch', (epoch) => this.onEpoch(epoch)),
      session.on('epochEnd', ({ epoch }) => this.onEpochEnd(epoch)),
      session.on('sample', (sample) => this.onSample(sample)),
    ];
  }

  /** The latest plan, or undefined before the schema is known. */
  get plan(): StreamPlan | undefined {
    return this.current;
  }

  /** The latest estimate of what the link carries. */
  get budget(): BudgetEstimate {
    return this.estimator.value;
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
    return this.events.on(event, listener);
  }

  /**
   * Replace what is asked for. It is planned once no other request came for the debounce time.
   *
   * @param requests Every variable wanted, with its rate and whether it is pinned.
   */
  request(requests: readonly RateRequest[]): void {
    if (sameRequests(this.requests, requests)) {
      return;
    }

    this.requests = requests;
    this.planSoon();
  }

  /** Plan what is asked for now, without waiting. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.replan();
  }

  /** Stop planning. The session keeps the groups it has. */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.detach.forEach((unsubscribe) => unsubscribe());
  }

  private planSoon(): void {
    if (this.closed) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private onEpoch(epoch: Epoch): void {
    const counter = this.requests.find((request) => request.countsDrops === true)?.variable;
    const id = this.session.schema?.find((entry) => entry.name === counter)?.id;
    const index = id === undefined ? -1 : epoch.variableIds.indexOf(id);

    if (index >= 0) {
      this.dropCounters.set(epoch.id, index);
    }
  }

  private onEpochEnd(epoch: Epoch): void {
    if (this.dropCounters.delete(epoch.id)) {
      this.robotDropped = undefined;
    }
  }

  private onSample(sample: SampleEvent): void {
    const index = this.dropCounters.get(sample.epoch);

    if (index !== undefined) {
      this.robotDropped = Number(sample.values[index]);
    }
  }

  private onStats(stats: LinkStats): void {
    const window = this.session.robot?.creditWindow ?? 0;
    const plan = this.current;
    const revision = this.estimator.value.revision;
    const estimate = this.estimator.update(
      stats,
      window,
      this.now(),
      plan?.overBudget === true,
      this.robotDropped
    );

    if (!plan || this.timer !== undefined) {
      return;
    }

    const overspent =
      estimate.saturated ||
      plan.usedBytesPerSecond > estimate.bytesPerSecond * (1 + this.overspendToReplan);

    if (this.retryTimer !== undefined) {
      if (overspent) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.replan();
      }

      return;
    }

    const ceilingMoved = plan.overBudget && estimate.revision !== revision;
    const roomToGrow =
      plan.overBudget &&
      estimate.bytesPerSecond > plan.budgetBytesPerSecond * (1 + this.growthToReplan);

    if (overspent || ceilingMoved || roomToGrow) {
      this.replan();
    }
  }

  private replan(): void {
    const schema = this.session.schema;
    const robot = this.session.robot;

    if (this.closed || !schema || !robot) {
      return;
    }

    const planned = planStreams({
      schema,
      loopTimeUs: robot.loopTimeUs,
      requests: this.requests.filter((request) => !this.refused.has(request.variable)),
      budgetBytesPerSecond: this.estimator.value.bytesPerSecond,
    });
    const plan = this.withRefused(planned);

    this.current = plan;
    this.events.emit('plan', plan);

    if (this.applied && sameGroups(this.applied, plan.groups)) {
      return;
    }

    const groups = plan.groups;
    this.applied = groups;
    this.session.setGroups(groups).then(
      (result) => {
        if (result.status === 'applied' && this.applied === groups) {
          this.failures = 0;
        }
      },
      (error: unknown) => this.onRefused(groups, error)
    );
  }

  private withRefused(plan: StreamPlan): StreamPlan {
    if (this.refused.size === 0) {
      return plan;
    }

    const refused: PlannedRate[] = this.requests
      .filter((request) => this.refused.has(request.variable))
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

  private onRefused(groups: readonly GroupRequest[], error: unknown): void {
    if (this.closed || this.applied !== groups || isSessionChange(error)) {
      return;
    }

    this.applied = undefined;

    if (error instanceof RobotError) {
      this.markRefused(groups);
    }

    this.events.emit('error', error instanceof Error ? error : new Error(String(error)));
    const wait = Math.min(MAX_RETRY_MS, this.retryMs * 2 ** this.failures);
    this.failures++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.replan();
    }, wait);
  }

  private markRefused(groups: readonly GroupRequest[]): void {
    const schema = this.session.schema;
    const streaming = new Set(this.session.openEpochs.flatMap((epoch) => epoch.variableIds));

    for (const id of groups.flatMap((group) => group.variableIds)) {
      const name = schema?.[id]?.name;

      if (name !== undefined && !streaming.has(id)) {
        this.refused.add(name);
      }
    }
  }
}
