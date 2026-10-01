import { wireSize } from '../link/credit';
import { SAMPLE_HEADER_SIZE, type GroupRequest } from '../link/epochs';
import type { SchemaEntry } from '../link/schema';
import { MAX_GROUP_VARIABLES, MAX_GROUPS, MAX_PAYLOAD_SIZE, TYPE_SIZE, TypeCode } from '../wire';

/** A variable to stream and how often, as the planner is asked for it. */
export interface RateRequest {
  /** The variable, by name. */
  readonly variable: string;
  /** Samples per second wanted. */
  readonly rateHz: number;
  /** Whether it is kept at its rate for as long as anything else can be slowed down instead. */
  readonly pinned?: boolean;
  /**
   * Whether the variable is the robot's own count of samples it dropped for want of credit,
   * which tells the budget when the link is full better than gaps seen on the monitor.
   */
  readonly countsDrops?: boolean;
}

/** What the planner fits into a budget. */
export interface PlanInput {
  /** The robot's schema. */
  readonly schema: readonly SchemaEntry[];
  /** The period of the robot's control loop, the unit of a group's period. */
  readonly loopTimeUs: number;
  /** What to stream; a variable may be asked for more than once, at the fastest rate asked. */
  readonly requests: readonly RateRequest[];
  /** The bytes per second samples may take. */
  readonly budgetBytesPerSecond: number;
}

/** The rate chosen for one variable. */
export interface PlannedRate {
  /** The variable, by name. */
  readonly variable: string;
  /** The fastest rate asked for it. */
  readonly rateHz: number;
  /** The rate its group streams at; 0 when it is not streamed. */
  readonly grantedHz: number;
  /** Whether it was pinned, so slowed down only after every unpinned stream. */
  readonly pinned: boolean;
}

/** Stream groups that fit a budget, and what they cost. */
export interface StreamPlan {
  /** One request per group, fastest first, ready for `Session.setGroups`. */
  readonly groups: readonly GroupRequest[];
  /** Every variable asked for that can stream, in the order first asked. */
  readonly rates: readonly PlannedRate[];
  /** Variables asked for that cannot stream, such as blobs or names the schema lacks; READ them. */
  readonly unstreamable: readonly string[];
  /** The budget the plan was made for. */
  readonly budgetBytesPerSecond: number;
  /** The bytes per second the groups take on the wire. */
  readonly usedBytesPerSecond: number;
  /** The bytes per second the groups would take at the rates asked. */
  readonly demandBytesPerSecond: number;
  /** Whether the rates asked do not fit the budget, so some were lowered or left out. */
  readonly overBudget: boolean;
}

/** The slowest a degraded stream goes, unless it asked for less. */
export const MIN_DEGRADED_RATE_HZ = 1;

const MAX_PERIOD_TICKS = 0xffff;
const MAX_SAMPLE_SIZE = MAX_PAYLOAD_SIZE - SAMPLE_HEADER_SIZE;
const SEARCH_STEPS = 32;

interface Wanted {
  readonly entry: SchemaEntry;
  rateHz: number;
  pinned: boolean;
  readonly order: number;
}

interface Group {
  readonly members: readonly Wanted[];
  readonly basePeriod: number;
  readonly floorPeriod: number;
  readonly pinned: boolean;
  readonly frameBytes: number;
}

/**
 * Choose stream groups for what is asked, within a budget.
 *
 * Variables are grouped by the period their rate turns into and by whether they are pinned, at
 * most `MAX_GROUPS` groups: classes that do not fit are merged, the pair that costs the fewest
 * extra bytes first, at the faster rate, and a pinned class with an unpinned one only when no
 * other merge is left. When the groups at the rates asked take more than the budget, every unpinned group
 * is slowed down by the same factor, no lower than {@link MIN_DEGRADED_RATE_HZ}, and only then
 * the pinned ones. A plan that does not fit even at those rates is kept, and says so.
 *
 * @param input What to stream, the schema and the budget.
 * @returns The groups and the rate of every variable.
 */
export function planStreams(input: PlanInput): StreamPlan {
  const { schema, loopTimeUs, budgetBytesPerSecond } = input;
  const { wanted, unstreamable } = gather(schema, input.requests);
  const { groups, leftOut } = formGroups(wanted, loopTimeUs);
  const periods = fitPeriods(groups, loopTimeUs, budgetBytesPerSecond);
  const granted = new Map<Wanted, number>();

  groups.forEach((group, index) => {
    for (const member of group.members) {
      granted.set(member, rateOf(periods[index], loopTimeUs));
    }
  });

  const demand = totalBytes(
    groups,
    groups.map((group) => group.basePeriod),
    loopTimeUs
  );
  const used = totalBytes(groups, periods, loopTimeUs);

  return {
    groups: groups.map((group, index) => ({
      variableIds: group.members.map((member) => member.entry.id),
      periodTicks: periods[index],
    })),
    rates: wanted.map((member) => ({
      variable: member.entry.name,
      rateHz: member.rateHz,
      grantedHz: granted.get(member) ?? 0,
      pinned: member.pinned,
    })),
    unstreamable,
    budgetBytesPerSecond,
    usedBytesPerSecond: used,
    demandBytesPerSecond: demand,
    overBudget: leftOut || demand > budgetBytesPerSecond,
  };
}

function gather(
  schema: readonly SchemaEntry[],
  requests: readonly RateRequest[]
): { wanted: Wanted[]; unstreamable: string[] } {
  const byName = new Map(schema.map((entry) => [entry.name, entry]));
  const wanted = new Map<string, Wanted>();
  const unstreamable = new Set<string>();

  for (const request of requests) {
    const entry = byName.get(request.variable);

    if (!entry || !entry.access.stream || entry.type === TypeCode.BLOB) {
      unstreamable.add(request.variable);
      continue;
    }

    if (!(request.rateHz > 0)) {
      continue;
    }

    const known = wanted.get(entry.name);

    if (known) {
      known.rateHz = Math.max(known.rateHz, request.rateHz);
      known.pinned ||= request.pinned === true;
    } else {
      wanted.set(entry.name, {
        entry,
        rateHz: request.rateHz,
        pinned: request.pinned === true,
        order: wanted.size,
      });
    }
  }

  return { wanted: [...wanted.values()], unstreamable: [...unstreamable] };
}

function periodFor(rateHz: number, loopTimeUs: number): number {
  const ticks = Math.round(1e6 / (rateHz * loopTimeUs));
  return Math.min(MAX_PERIOD_TICKS, Math.max(1, ticks));
}

function rateOf(periodTicks: number, loopTimeUs: number): number {
  return 1e6 / (periodTicks * loopTimeUs);
}

function sampleSizeOf(members: readonly Wanted[]): number {
  return members.reduce((total, member) => total + TYPE_SIZE[member.entry.type], 0);
}

/** Split members of one rate into groups a frame can carry. */
function chunk(members: readonly Wanted[]): Wanted[][] {
  const chunks: Wanted[][] = [];
  let current: Wanted[] = [];
  let size = 0;

  for (const member of members) {
    const bytes = TYPE_SIZE[member.entry.type];

    if (current.length === MAX_GROUP_VARIABLES || size + bytes > MAX_SAMPLE_SIZE) {
      chunks.push(current);
      current = [];
      size = 0;
    }

    current.push(member);
    size += bytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

interface RateClass {
  period: number;
  pinned: boolean;
  members: Wanted[];
}

function groupCount(classes: readonly RateClass[]): number {
  return classes.reduce((total, rateClass) => total + chunk(rateClass.members).length, 0);
}

function classBytes(members: readonly Wanted[], period: number, loopTimeUs: number): number {
  return chunk(members).reduce(
    (total, group) =>
      total + wireSize(SAMPLE_HEADER_SIZE + sampleSizeOf(group)) * rateOf(period, loopTimeUs),
    0
  );
}

function byPriority(a: Wanted, b: Wanted): number {
  return Number(b.pinned) - Number(a.pinned) || b.rateHz - a.rateHz || a.order - b.order;
}

/**
 * The two classes whose merge, at the faster period, costs the fewest extra bytes; classes that
 * are both pinned or both unpinned first, so a pinned variable only shares a group with unpinned
 * ones when the robot's groups run out otherwise.
 */
function cheapestMerge(classes: readonly RateClass[], loopTimeUs: number): [number, number] {
  let best: [number, number] = [0, 1];
  let bestCost = Number.POSITIVE_INFINITY;
  let bestMixed = true;

  for (let first = 0; first < classes.length; first++) {
    for (let second = first + 1; second < classes.length; second++) {
      const a = classes[first];
      const b = classes[second];
      const mixed = a.pinned !== b.pinned;
      const period = Math.min(a.period, b.period);
      const cost =
        classBytes([...a.members, ...b.members], period, loopTimeUs) -
        classBytes(a.members, a.period, loopTimeUs) -
        classBytes(b.members, b.period, loopTimeUs);

      if ((bestMixed && !mixed) || (mixed === bestMixed && cost < bestCost)) {
        best = [first, second];
        bestCost = cost;
        bestMixed = mixed;
      }
    }
  }

  return best;
}

function formGroups(
  wanted: readonly Wanted[],
  loopTimeUs: number
): { groups: Group[]; leftOut: boolean } {
  const classes: RateClass[] = [];

  for (const member of wanted) {
    const period = periodFor(member.rateHz, loopTimeUs);
    const rateClass = classes.find(
      (candidate) => candidate.period === period && candidate.pinned === member.pinned
    );

    if (rateClass) {
      rateClass.members.push(member);
    } else {
      classes.push({ period, pinned: member.pinned, members: [member] });
    }
  }

  const byPeriod = (a: RateClass, b: RateClass) =>
    a.period - b.period || Number(b.pinned) - Number(a.pinned);
  classes.sort(byPeriod);

  while (classes.length > 1 && groupCount(classes) > MAX_GROUPS) {
    const [first, second] = cheapestMerge(classes, loopTimeUs);
    const kept = classes[first];
    const merged = classes[second];
    kept.period = Math.min(kept.period, merged.period);
    kept.pinned ||= merged.pinned;
    kept.members.push(...merged.members);
    classes.splice(second, 1);
    classes.sort(byPeriod);
  }

  const groups: Group[] = [];
  let leftOut = false;

  for (const rateClass of classes) {
    for (const members of chunk(rateClass.members.toSorted(byPriority))) {
      if (groups.length === MAX_GROUPS) {
        leftOut = true;
        break;
      }

      const fastest = Math.max(...members.map((member) => member.rateHz));
      groups.push({
        members: members.toSorted((a, b) => a.order - b.order),
        basePeriod: rateClass.period,
        floorPeriod: Math.max(
          rateClass.period,
          periodFor(Math.min(fastest, MIN_DEGRADED_RATE_HZ), loopTimeUs)
        ),
        pinned: members.some((member) => member.pinned),
        frameBytes: wireSize(SAMPLE_HEADER_SIZE + sampleSizeOf(members)),
      });
    }
  }

  return { groups, leftOut };
}

function totalBytes(
  groups: readonly Group[],
  periods: readonly number[],
  loopTimeUs: number
): number {
  return groups.reduce(
    (total, group, index) => total + group.frameBytes * rateOf(periods[index], loopTimeUs),
    0
  );
}

function scaled(group: Group, factor: number): number {
  return Math.min(group.floorPeriod, Math.ceil(group.basePeriod / factor));
}

/**
 * The periods that fit the budget: unpinned groups slowed first, all by one factor found by
 * bisection, then the pinned ones the same way.
 */
function fitPeriods(groups: readonly Group[], loopTimeUs: number, budget: number): number[] {
  const periods = groups.map((group) => group.basePeriod);
  const cost = () => totalBytes(groups, periods, loopTimeUs);

  for (const pinned of [false, true]) {
    if (cost() <= budget) {
      break;
    }

    const indices = groups.flatMap((group, index) => (group.pinned === pinned ? [index] : []));
    const apply = (factor: number) => {
      for (const index of indices) {
        periods[index] = scaled(groups[index], factor);
      }
    };

    apply(0);

    if (cost() > budget) {
      continue;
    }

    let low = 0;
    let high = 1;

    for (let step = 0; step < SEARCH_STEPS; step++) {
      const middle = (low + high) / 2;
      apply(middle);

      if (cost() <= budget) {
        low = middle;
      } else {
        high = middle;
      }
    }

    apply(low);
  }

  return periods;
}
