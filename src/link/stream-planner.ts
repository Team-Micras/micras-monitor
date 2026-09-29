import { Emitter, type Listener, type Unsubscribe } from './emitter';
import type { GroupRequest } from './groups';
import { LinkBudget, type BudgetEstimate, type LinkBudgetOptions } from './link-budget';
import type { Session } from './session';
import type { LinkStats } from './session-types';
import { planStreams, type RateRequest, type StreamPlan } from './stream-plan';

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
  /** The current time in milliseconds; `performance.now` by default. */
  now?: () => number;
}

/** What a stream planner emits. */
export interface StreamPlannerEvents {
  /** A new plan, applied or about to be. */
  plan: StreamPlan;
  /** The session refused a plan. */
  error: Error;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_GROWTH_TO_REPLAN = 0.2;
const DEFAULT_OVERSPEND_TO_REPLAN = 0.1;

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
 * reconfigures the robot once. The budget is estimated again with every stats event of the
 * session; a plan that no longer fits, or that samples drop under, is made again at once, and one
 * that was cut is made again when the budget grew enough to be worth a reconfiguration. The robot is only reconfigured when
 * the groups change.
 */
export class StreamPlanner {
  private readonly events = new Emitter<StreamPlannerEvents>();
  private readonly estimator: LinkBudget;
  private readonly debounceMs: number;
  private readonly growthToReplan: number;
  private readonly overspendToReplan: number;
  private readonly now: () => number;
  private readonly detach: Unsubscribe[];
  private requests: readonly RateRequest[] = [];
  private current: StreamPlan | undefined;
  private applied: readonly GroupRequest[] | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  /**
   * @param session The session whose groups the planner owns.
   * @param options How to plan.
   */
  constructor(
    private readonly session: Session,
    options: StreamPlannerOptions = {}
  ) {
    this.estimator = new LinkBudget(options.budget);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.growthToReplan = options.growthToReplan ?? DEFAULT_GROWTH_TO_REPLAN;
    this.overspendToReplan = options.overspendToReplan ?? DEFAULT_OVERSPEND_TO_REPLAN;
    this.now = options.now ?? (() => performance.now());
    this.detach = [
      session.on('schema', () => {
        this.applied = undefined;
        this.planSoon();
      }),
      session.on('stats', (stats) => this.onStats(stats)),
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
    this.detach.forEach((unsubscribe) => unsubscribe());
  }

  private planSoon(): void {
    if (this.closed) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private onStats(stats: LinkStats): void {
    const window = this.session.robot?.creditWindow ?? 0;
    const estimate = this.estimator.update(
      stats,
      window,
      this.now(),
      this.current?.overBudget === true
    );
    const plan = this.current;

    if (!plan || this.timer !== undefined) {
      return;
    }

    const overspent =
      estimate.saturated ||
      plan.usedBytesPerSecond > estimate.bytesPerSecond * (1 + this.overspendToReplan);
    const roomToGrow =
      plan.overBudget &&
      estimate.bytesPerSecond > plan.budgetBytesPerSecond * (1 + this.growthToReplan);

    if (overspent || roomToGrow) {
      this.replan();
    }
  }

  private replan(): void {
    const schema = this.session.schema;
    const robot = this.session.robot;

    if (this.closed || !schema || !robot) {
      return;
    }

    const plan = planStreams({
      schema,
      loopTimeUs: robot.loopTimeUs,
      requests: this.requests,
      budgetBytesPerSecond: this.estimator.value.bytesPerSecond,
    });

    this.current = plan;
    this.events.emit('plan', plan);

    if (this.applied && sameGroups(this.applied, plan.groups)) {
      return;
    }

    this.applied = plan.groups;
    this.session.setGroups(plan.groups).catch((error: unknown) => {
      this.applied = undefined;
      this.events.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
  }
}
