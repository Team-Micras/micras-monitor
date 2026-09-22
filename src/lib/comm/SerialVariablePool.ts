import { ISerialVariable, Fundamental, isFundamental } from './variables/ISerialVariable';
import { PrimitiveSerialVariable } from './variables/PrimitiveSerialVariable';
import { CustomSerialVariable } from './variables/CustomSerialVariable';
import { ISerializable } from './ISerializable';
import { Access, TypeCode } from './Protocol';
import { TYPE_SIZE, readValue } from './TypeCodec';

export type SerializableClasses = {
  [key: string]: new () => ISerializable;
};

export type VariableChangeCallback = (id: number, variable: ISerialVariable) => void;

/**
 * The samples of one variable: the robot's own timestamps in milliseconds, and the values.
 */
export type LogData = [Array<number>, Array<Fundamental | ISerializable>];

/**
 * One entry of the schema, as the firmware describes it.
 */
export interface SchemaEntry {
  id: number;
  type: TypeCode;
  access: Access;
  name: string;
}

/**
 * Every variable the robot exposes, and the samples that have arrived for each of them.
 *
 * The identifiers are registration order in the firmware, so adding one variable there shifts every
 * later one. That is why the schema is stamped with a hash and cached against it, instead of being
 * trusted because it was fetched once.
 */
export class SerialVariablePool {
  static readonly LOG_BUFFER_SIZE = 1000000;

  private variables: Map<number, ISerialVariable> = new Map();
  private variableChangeCallbacks: VariableChangeCallback[] = [];
  private variableWriteCallbacks: VariableChangeCallback[] = [];
  private nameToIdMap: Map<string, number> = new Map();
  private logs: Map<number, LogData> = new Map();
  private customClasses: SerializableClasses;
  private hash = 0;

  /**
   * @param customSerializableClasses Classes to build the variables the firmware registered as
   * blobs, keyed by the name they are registered under there.
   */
  constructor(customSerializableClasses?: SerializableClasses) {
    this.customClasses = customSerializableClasses ?? {};
  }

  /**
   * Replace the schema with the one the robot just described.
   *
   * @param hash The hash the robot stamped the schema with.
   * @param entries Every variable, in identifier order.
   */
  setSchema(hash: number, entries: SchemaEntry[]): void {
    this.variables.clear();
    this.nameToIdMap.clear();
    this.logs.clear();
    this.hash = hash;

    for (const entry of entries) {
      this.variables.set(entry.id, this.build(entry));
      this.nameToIdMap.set(entry.name, entry.id);
    }
  }

  /**
   * The hash of the schema currently loaded, which is what the robot has to agree with.
   */
  getSchemaHash(): number {
    return this.hash;
  }

  /**
   * Every variable, in identifier order, as the schema described it.
   */
  getSchema(): SchemaEntry[] {
    return [...this.variables.entries()].map(([id, variable]) => ({
      id,
      type: variable.getTypeCode(),
      access: variable.getAccess(),
      name: variable.getName(),
    }));
  }

  /**
   * Take the values of one group out of a sample, all captured in the same control loop iteration.
   *
   * @param ids The variables of the group, in the order they are packed.
   * @param timestampMs When the robot captured them.
   * @param values The packed values.
   */
  applySample(ids: number[], timestampMs: number, values: Uint8Array): void {
    let offset = 0;

    for (const id of ids) {
      const variable = this.variables.get(id);

      if (!variable) {
        continue;
      }

      const type = variable.getTypeCode();
      const value = readValue(values, offset, type);
      offset += TYPE_SIZE[type];

      if (value === null) {
        return;
      }

      this.record(id, variable, value, timestampMs);
    }
  }

  /**
   * Take the value of a single variable, as a reply to a read.
   *
   * @param id The variable the value belongs to.
   * @param data The bytes of the value.
   * @param timestampMs When it was taken, as far as this side can tell.
   */
  applyValue(id: number, data: Uint8Array, timestampMs: number): void {
    const variable = this.variables.get(id);

    if (!variable) {
      return;
    }

    const lastValue = variable.getReference().value;
    variable.deserialize(data);
    this.record(id, variable, variable.getReference().value, timestampMs, lastValue);
  }

  /**
   * Be told whenever a value changes, whoever changed it. This is what the interface redraws on.
   */
  addVariableChangeListener(callback: VariableChangeCallback): void {
    this.variableChangeCallbacks.push(callback);
  }

  /**
   * Be told only when a value is changed from here, which is what has to be sent to the robot.
   *
   * @note Keeping this apart from the change listeners is what stops a sample from being echoed
   * straight back as a write. With one list, every value the robot sent would be written back to
   * it, and a value set here would be overwritten by whichever sample was already in flight.
   */
  addVariableWriteListener(callback: VariableChangeCallback): void {
    this.variableWriteCallbacks.push(callback);
  }

  /**
   * Set a variable from here, which sends it to the robot.
   *
   * @example
   * ```typescript
   * pool.updateVariable<number>(variableId, (valueRef) => {
   *   valueRef.value = 42;
   * });
   * ```
   */
  updateVariable<T extends Fundamental | ISerializable>(
    id: number,
    setter: (valueRef: { value: T }) => void
  ): void {
    const variable = this.variables.get(id);

    if (!variable) {
      console.warn(`No variable found with ID: ${id}`);
      return;
    }

    if (variable.isReadOnly()) {
      console.warn(`Variable ${variable.getName()} is read-only and cannot be updated.`);
      return;
    }

    const valueRef = variable.getReference();
    setter(valueRef as { value: T });
    this.notifyVariableChange(id, variable);

    for (const callback of this.variableWriteCallbacks) {
      callback(id, variable);
    }
  }

  /**
   * Set a variable by name, which sends it to the robot.
   */
  updateVariableByName<T extends Fundamental | ISerializable>(
    name: string,
    setter: (valueRef: { value: T }) => void
  ): void {
    const id = this.nameToIdMap.get(name);

    if (id === undefined) {
      console.warn(`No variable found with name: ${name}`);
      return;
    }

    this.updateVariable(id, setter);
  }

  getVariable(id: number): ISerialVariable | undefined {
    return this.variables.get(id);
  }

  getVariableByName(name: string): ISerialVariable | undefined {
    return this.variables.get(this.nameToIdMap.get(name) ?? -1);
  }

  getVariableId(name: string): number | undefined {
    return this.nameToIdMap.get(name);
  }

  getVariableCount(): number {
    return this.variables.size;
  }

  getVariableLogs(id: number): LogData | undefined {
    return this.logs.get(id);
  }

  clearVariableLogs(): void {
    this.logs.clear();
  }

  forEach(callback: (variable: ISerialVariable, id: number) => void): void {
    this.variables.forEach((variable, id) => {
      callback(variable, id);
    });
  }

  private build(entry: SchemaEntry): ISerialVariable {
    if (entry.type !== TypeCode.BLOB) {
      return new PrimitiveSerialVariable(entry.name, entry.type, entry.access);
    }

    const ClassConstructor = this.resolveClass(entry.name);

    if (!ClassConstructor) {
      console.warn(`No class registered to decode the blob "${entry.name}"`);
    }

    return new CustomSerialVariable(
      entry.name,
      { value: ClassConstructor ? new ClassConstructor() : new UnknownBlob() },
      entry.access
    );
  }

  /**
   * Find the class that decodes a blob, by the name the firmware registered it under or by the
   * last segment of that name, so that a prefix does not have to be repeated here.
   */
  private resolveClass(name: string): (new () => ISerializable) | undefined {
    return this.customClasses[name] ?? this.customClasses[name.split('/').pop() ?? name];
  }

  private record(
    id: number,
    variable: ISerialVariable,
    value: Fundamental | ISerializable,
    timestampMs: number,
    lastValue?: Fundamental | ISerializable
  ): void {
    const previous = lastValue ?? variable.getReference().value;

    if (isFundamental(value)) {
      variable.getReference().value = value;
    }

    if (!this.logs.has(id)) {
      this.logs.set(id, [[], []]);
    }

    const logData = this.logs.get(id) as LogData;
    logData[0].push(timestampMs);
    logData[1].push(value);

    if (logData[0].length > SerialVariablePool.LOG_BUFFER_SIZE) {
      logData[0].shift();
      logData[1].shift();
    }

    if (this.hasValueChanged(previous, value, variable)) {
      this.notifyVariableChange(id, variable);
    }
  }

  private notifyVariableChange(id: number, variable: ISerialVariable): void {
    for (const callback of this.variableChangeCallbacks) {
      callback(id, variable);
    }
  }

  private hasValueChanged(
    lastValue: Fundamental | ISerializable,
    newValue: Fundamental | ISerializable,
    variable: ISerialVariable
  ): boolean {
    if (isFundamental(newValue)) {
      return newValue !== lastValue;
    }

    return !variable.isEquals(lastValue as ISerializable);
  }
}

/**
 * Stands in for a blob no class was registered for, so that the rest of the schema still loads.
 */
class UnknownBlob implements ISerializable {
  private bytes: Uint8Array = new Uint8Array(0);

  serialize(): Uint8Array {
    return this.bytes;
  }

  deserialize(serialData: Uint8Array): void {
    this.bytes = serialData;
  }

  isEquals(other: ISerializable): boolean {
    return other === this;
  }
}
