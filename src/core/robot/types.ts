/**
 * The contracts of a robot package: what the monitor knows about one robot beyond its schema.
 *
 * The layer is framework free. Views are plain functions typed by the `Node` they return, so a
 * package written for React is a `RobotPackage<ReactNode>` without this layer importing React.
 *
 * @module
 */

/** What a view of a serializable value receives. */
export interface BlobViewProps<T> {
  readonly value: T;
  /**
   * The latest values of the robot's numeric roles the app follows for the view, such as the pose
   * over a map; a role without a value is absent.
   */
  readonly roles?: Readonly<Partial<Record<Role, number>>>;
}

/**
 * A composite type the firmware serializes into a blob, with the class that decodes it and the
 * view that draws it.
 */
export interface SerializableType<T = unknown, Node = unknown> {
  readonly kind: 'serializable';
  /** The type tag the firmware declares for the class, which blob entries of the schema carry. */
  readonly tag: string;
  /** The name shown for the type, such as `Maze`. */
  readonly name: string;
  /**
   * The numeric roles the view reads through `roles`, such as the pose over a map; the app streams
   * and follows them while the view is on screen.
   */
  readonly follows?: readonly Role[];
  /**
   * Turns the blob's bytes into a value.
   *
   * @throws {Error} When the bytes are not a valid encoding of the type.
   */
  readonly decode: (bytes: Uint8Array) => T;
  /**
   * Draws a decoded value; a React package returns a `ReactNode`. Declared as a method so that a
   * package can list types of different values together as `SerializableType<unknown>`, and
   * without `this`, so that the app renders it as a component.
   */
  View(this: void, props: BlobViewProps<T>): Node;
}

/** One value of an enum. */
export interface EnumOption {
  readonly value: number;
  readonly label: string;
  readonly description?: string;
}

/** Labels for the values of an integer variable, such as a state or an objective. */
export interface EnumType {
  readonly kind: 'enum';
  readonly name: string;
  readonly options: readonly EnumOption[];
}

/** One bit of a bitmask. */
export interface BitFlag {
  /** The bit's position, 0 for the least significant bit. */
  readonly bit: number;
  readonly label: string;
  readonly description?: string;
}

/** Labels for the bits of an integer variable used as a set of flags. */
export interface BitmaskType {
  readonly kind: 'bitmask';
  readonly name: string;
  readonly flags: readonly BitFlag[];
}

/**
 * What a variable means to the generic parts of the monitor. The Robot window and the stream
 * planner find the state, the battery or the pose by role, never by name.
 */
export type Role =
  | 'state'
  | 'battery'
  | 'pose.x'
  | 'pose.y'
  | 'pose.heading'
  | 'map'
  | 'map.revision'
  | 'link.dropped'
  | 'link.credit';

/** How the monitor presents one variable of a known robot. */
export interface VariableSpec {
  readonly unit?: string;
  readonly description?: string;
  /** A CSS color for its series, when the package wants a stable one. */
  readonly color?: string;
  /** Labels for an integer variable. */
  readonly labels?: EnumType | BitmaskType;
  /** The type of a blob, by tag, for firmware that does not send the tag. */
  readonly serializable?: string;
}

/** The argument a command takes. */
export interface CommandArgument {
  readonly label: string;
  /** The value sent when the user does not pick one. */
  readonly default: number;
  /** Named values to pick from; without them the argument is a plain number. */
  readonly options?: EnumType;
}

/** A command of the robot. */
export interface CommandSpec {
  /** The code the COMMAND message carries. */
  readonly code: number;
  /** The command as the robot names it, such as `EXPLORE`. */
  readonly name: string;
  /** What a button says, such as `Explore`. */
  readonly label: string;
  /** The name of a Lucide icon, such as `compass`. */
  readonly icon?: string;
  readonly description?: string;
  /** A question to confirm before sending, for dangerous commands; none when omitted. */
  readonly confirm?: string;
  /**
   * The values of the state variable in which the robot accepts the command, mirroring the
   * firmware's table, or `'any'`. The UI only hints with it; the robot's answer is what counts.
   */
  readonly acceptedIn: readonly number[] | 'any';
  readonly argument?: CommandArgument;
  /**
   * Whether the command stays in reach whatever is on screen: in the top bar, at the bottom of the
   * phone view, and always sent to the live robot, even while a recording is shown.
   */
  readonly pinned?: boolean;
  /**
   * The key that sends it, as the keymap writes chords, such as `Space` or `Alt+E`; the user can
   * bind it to another. It works wherever the focus is but in a text field.
   */
  readonly key?: string;
  /** `danger` draws it in the stop color, prominent, and lets its key match with modifiers held. */
  readonly tone?: 'danger';
}

/** A window of a layout preset. `kind` names a window kind of the app. */
export interface PresetWindow {
  readonly kind: string;
  readonly title?: string;
  /** The variables it shows, by name. */
  readonly variables?: readonly string[];
}

/** A node of a layout preset's split tree. */
export type PresetNode =
  | { readonly window: PresetWindow }
  | {
      readonly split: 'row' | 'column';
      /** The first child's share of the space, strictly in (0, 1). */
      readonly ratio: number;
      readonly first: PresetNode;
      readonly second: PresetNode;
    };

/** A workspace layout the package suggests, which the user can edit and save as their own. */
export interface LayoutPreset {
  readonly name: string;
  readonly root: PresetNode | null;
}

/** Everything the monitor knows about one robot. */
export interface RobotPackage<Node = unknown> {
  /** The robot's name as HELLO_ACK announces it, such as `micras`. */
  readonly id: string;
  /** The name shown to people, such as `Micras`. */
  readonly displayName: string;
  /**
   * Variable names that together identify the robot when its firmware does not announce a name.
   * An empty signature never matches.
   */
  readonly signature: readonly string[];
  readonly roles: Readonly<Partial<Record<Role, string>>>;
  /**
   * The values of the state role in which the robot is at rest, so that the monitor may reload or
   * update itself without cutting a run short. Without it the state whose enum label is `IDLE`
   * counts, in any case.
   */
  readonly idleStates?: readonly number[];
  /** Presentation of variables, by name. */
  readonly variables: Readonly<Record<string, VariableSpec>>;
  readonly types: readonly SerializableType<unknown, Node>[];
  readonly commands: readonly CommandSpec[];
  /**
   * Reads a line of the robot's log that reports a transition of its state, giving the value of
   * the state it entered, or null for any other line. With it the Robot window takes the
   * transitions from the robot's own timestamps, which keep states shorter than a sample.
   */
  readonly stateLog?: (text: string) => number | null;
  /** Why the robot refused a command, by the reason byte of COMMAND_ACK. */
  readonly refusalReasons: Readonly<Record<number, string>>;
  readonly presets: readonly LayoutPreset[];
}
