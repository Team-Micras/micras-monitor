import { ISerialVariable, Fundamental, isFundamental } from './variables/ISerialVariable';
import { CppBinarySerializer } from './CppSerializer';
import { PrimitiveSerialVariable } from './variables/PrimitiveSerialVariable';
import { CustomSerialVariable } from './variables/CustomSerialVariable';
import { ISerializable } from './ISerializable';

export type SerializableClasses = {
  [key: string]: new () => ISerializable;
};

type SerialVariableFactory = (name: string, readOnly: boolean) => ISerialVariable;
export type VariableChangeCallback = (id: number, variable: ISerialVariable) => void;

export type LogData = [Array<number>, Array<Fundamental | ISerializable>];

export class SerialVariablePool {
  static readonly LOG_BUFFER_SIZE = 1000000;

  private variables: Map<number, ISerialVariable> = new Map();
  private factories: Record<string, SerialVariableFactory> = {};
  private variableChangeCallbacks: VariableChangeCallback[] = [];
  private nameToIdMap: Map<string, number> = new Map();
  private logs: Map<number, LogData> = new Map();

  /**
   * Constructor for the SerialVariablePool class.
   *
   * @param customSerializableClasses Optional list of custom serializable classes that implement ISerializable
   *
   * @description This constructor initializes the variable pool with a map of custom serializable classes.
   * It allows the pool to create instances of these classes when deserializing data.
   *
   * @example
   * ```typescript
   * // If your typescript serializable classes does not have the same name as in the C++
   * // firmware, you can create a map of the C++ class names to the typescript class:
   * const mySerializableClasses = {
   *   "CppMyFirstClass": MyFirstClass,
   *   "CppMySecondClass": MySecondClass,
   * };
   *
   * // If your typescript serializable classes have the same name as in the C++ firmware:
   * const mySerializableClasses = {
   *   MyFirstClass,
   *   MySecondClass,
   * };
   *
   * // If you have a template class in C++ like MyClass<T>, you can register it like this:
   * const mySerializableClasses = {
   *   MyClass, // This will match MyClass<int>, MyClass<string>, etc.
   *   "MyClass<int>": MyClassInt, // If you have a specific instantiation you can map accordingly
   * };
   *
   * const pool = new SerialVariablePool(mySerializableClasses);
   * ```
   */
  constructor(customSerializableClasses?: SerializableClasses) {
    this.registerPrimitiveFactories();

    if (customSerializableClasses) {
      this.registerCustomFactories(customSerializableClasses);
    }
  }

  /**
   * Add a variable change listener
   *
   * @param callback Callback function to be called when a variable changes
   */
  addVariableChangeListener(callback: VariableChangeCallback): void {
    this.variableChangeCallbacks.push(callback);
  }

  /**
   * Update a variable by ID
   *
   * @param id Variable ID
   * @param setter Function to set the variable value
   *
   * @description This method updates a variable by its ID.
   * It calls the provided setter function to set the variable value.
   * The setter function receives a reference to the variable's value.
   * It is important to note that the setter function should not directly
   * modify the variable's value, but rather use the reference to update it.
   * This ensures that the variable's change is properly tracked and notified.
   *
   * @example
   * ```typescript
   * pool.updateVariable<number>(variableId, (valueRef) => {
   *   valueRef.value = 42; // Update the variable value
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
  }

  /**
   * Update a variable by name
   *
   * @param name Variable name
   * @param setter Function to set the variable value
   *
   * @description This method updates a variable by its name.
   * It calls the provided setter function to set the variable value.
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

  /**
   * Deserialize the variable map from a byte array
   *
   * @param data Serialized variable map
   *
   * @description This method deserializes the variable map from a byte array.
   * It populates the variables map with instances of the appropriate types.
   */
  deserializeVarMap(data: Uint8Array): void {
    this.variables.clear();
    this.nameToIdMap.clear();

    try {
      const count = data[0] | (data[1] << 8);
      let offset = 2;

      for (let i = 0; i < count; i++) {
        const id = data[offset] | (data[offset + 1] << 8);
        offset += 2;

        const nameLength = data[offset++];
        const nameBytes = data.slice(offset, offset + nameLength);
        const decoder = new TextDecoder();
        const name = decoder.decode(nameBytes);
        offset += nameLength;

        const typeLength = data[offset++];
        const typeBytes = data.slice(offset, offset + typeLength);
        const type = decoder.decode(typeBytes);
        offset += typeLength;

        const readOnly = data[offset++] !== 0;

        const factoryType = this.getFactoryType(type);
        if (factoryType) {
          const variable = this.factories[factoryType](name, readOnly);
          this.variables.set(id, variable);
          this.nameToIdMap.set(name, id);
        } else {
          console.warn(`No factory registered for type: ${type}`);
        }
      }
    } catch (error) {
      console.error('Error deserializing variable map:', error);
    }
  }

  /**
   * Deserialize a variable by ID
   *
   * @param id Variable ID
   * @param data Serialized variable data
   *
   * @description This method deserializes a variable by its ID.
   * It populates the variable with the deserialized data.
   */
  deserializeVariable(id: number, data: Uint8Array): void {
    const variable = this.variables.get(id);
    if (!variable) {
      console.warn(`No variable found with ID: ${id}`);
      return;
    }

    const lastValue = variable.getReference().value;
    variable.deserialize(data);
    const newValue = variable.getReference().value;

    this.addVariableToLog(id, newValue);

    if (this.hasValueChanged(lastValue, newValue, variable)) {
      this.notifyVariableChange(id, variable);
    }
  }

  /**
   * Get the variable by ID
   *
   * @param id Variable ID
   *
   * @description This method retrieves a variable by its ID.
   * It returns the variable if found, or undefined if not.
   */
  getVariable(id: number): ISerialVariable | undefined {
    return this.variables.get(id);
  }

  /**
   * Get the variable by name
   *
   * @param name Variable name
   *
   * @description This method retrieves a variable by its name.
   * It returns the variable if found, or undefined if not.
   */
  getVariableByName(name: string): ISerialVariable | undefined {
    return this.variables.get(this.nameToIdMap.get(name) ?? -1);
  }

  /**
   * Get the number of variables in the pool
   *
   * @description This method returns the number of variables in the pool.
   * It is useful for iterating over the variables.
   */
  getVariableCount(): number {
    return this.variables.size;
  }

  /**
   * Get the logs for a variable
   *
   * @param id Variable ID
   * @returns Variable logs
   */
  getVariableLogs(id: number): LogData | undefined {
    return this.logs.get(id);
  }

  /**
   * Iterate over the variables in the pool
   *
   * @param callback Callback function to be called for each variable
   *
   * @description This method iterates over the variables in the pool.
   * It calls the provided callback function for each variable.
   */
  forEach(callback: (variable: ISerialVariable, id: number) => void): void {
    this.variables.forEach((variable, id) => {
      callback(variable, id);
    });
  }

  /**
   * Register primitive types with their default values
   *
   * @description This method registers the primitive types with their default values.
   * It allows the pool to create instances of these types when deserializing data.
   */
  private registerPrimitiveFactories() {
    CppBinarySerializer.CPP_TYPE_VALUES.forEach((cppType) => {
      const defaultValue = CppBinarySerializer.getTsType(cppType);
      this.factories[cppType] = (name: string, readOnly: boolean) =>
        new PrimitiveSerialVariable(name, { value: defaultValue }, readOnly, cppType);
    });
  }

  /**
   * Register custom serializable classes
   *
   * @param classes Object containing class constructors
   *
   * @description This method registers custom serializable classes with the pool.
   * It allows the pool to create instances of these classes when deserializing data.
   */
  private registerCustomFactories(classes: SerializableClasses): void {
    for (const className in classes) {
      const ClassConstructor = classes[className];
      this.factories[className] = (name: string, readOnly: boolean) =>
        new CustomSerialVariable(name, { value: new ClassConstructor() }, readOnly);
    }
  }

  /**
   * Get the factory type for a given type string
   *
   * @param type The type string to resolve
   * @returns The factory type if found, null otherwise
   */
  private getFactoryType(type: string): string | null {
    if (this.factories[type]) {
      return type;
    }

    const templateRegex = /^(\w+)<(.+)>$/;
    const match = type.match(templateRegex);

    if (match) {
      const [, templateTypeName] = match;
      if (this.factories[templateTypeName]) {
        return templateTypeName;
      }
    }

    return null;
  }

  /**
   * Add a variable's value to the log
   *
   * @param id Variable ID
   * @param value Variable value
   */
  private addVariableToLog(id: number, value: Fundamental | ISerializable): void {
    if (!this.logs.has(id)) {
      this.logs.set(id, [[], []]);
    }

    const logData = this.logs.get(id) as LogData;
    logData[0].push(window.performance.now());
    logData[1].push(value);

    if (logData[0].length > SerialVariablePool.LOG_BUFFER_SIZE) {
      logData[0].shift();
      logData[1].shift();
    }
  }

  /**
   * Notify all listeners of a variable change
   *
   * @param id Variable ID
   * @param variable Variable instance
   */
  private notifyVariableChange(id: number, variable: ISerialVariable): void {
    // console.log(`Variable changed: ${variable.getName()} (ID: ${id})`);
    for (const callback of this.variableChangeCallbacks) {
      callback(id, variable);
    }
  }

  /**
   * Check if a variable's value has changed
   *
   * @param lastValue The previous value
   * @param newValue The new value
   * @param variable The variable instance for comparison
   * @returns True if the value has changed, false otherwise
   */
  private hasValueChanged(
    lastValue: Fundamental | ISerializable,
    newValue: Fundamental | ISerializable,
    variable: ISerialVariable
  ): boolean {
    if (isFundamental(newValue)) {
      return newValue !== lastValue;
    } else {
      return !variable.isEquals(lastValue as ISerializable);
    }
  }
}
