import { ISerializable } from "@/lib/comm/ISerializable";

/**
 * Position interface representing x, y coordinates.
 */
export interface Position {
  x: number;
  y: number;
}

/**
 * Pose interface representing position and orientation.
 */
export interface Pose {
  position: Position;
  orientation: number;
}

/**
 * Velocity interface representing linear and angular velocity.
 */
export interface Velocity {
  linear: number;
  angular: number;
}

/**
 * State class representing the robot's state including pose and velocity.
 * Implements ISerializable for communication with C++ counterpart.
 */
export class State implements ISerializable {
  public pose: Pose;
  public velocity: Velocity;

  constructor(
    pose: Pose = { position: { x: 0, y: 0 }, orientation: 0 },
    velocity: Velocity = { linear: 0, angular: 0 }
  ) {
    this.pose = pose;
    this.velocity = velocity;
  }

  /**
   * Serialize the State instance to match C++ serialization.
   * Serializes: pose.position.x, pose.position.y, pose.orientation, velocity.linear, velocity.angular.
   *
   * @returns Serialized data as Uint8Array (20 bytes)
   */
  serialize(): Uint8Array {
    const serialData = new Uint8Array(20);
    const dataView = new DataView(serialData.buffer);

    dataView.setFloat32(0, this.pose.position.x, true);
    dataView.setFloat32(4, this.pose.position.y, true);
    dataView.setFloat32(8, this.pose.orientation, true);
    dataView.setFloat32(12, this.velocity.linear, true);
    dataView.setFloat32(16, this.velocity.angular, true);

    return serialData;
  }

  /**
   * Deserialize the State instance from serialized data to match C++ deserialization.
   * Expected format: pose.position.x, pose.position.y, pose.orientation, velocity.linear, velocity.angular.
   *
   * @param serialData Serialized data as Uint8Array (must be exactly 20 bytes)
   */
  deserialize(serialData: Uint8Array): void {
    if (serialData.length !== 20) {
      return;
    }

    const dataView = new DataView(serialData.buffer, serialData.byteOffset);
    this.pose.position.x = dataView.getFloat32(0, true);
    this.pose.position.y = dataView.getFloat32(4, true);
    this.pose.orientation = dataView.getFloat32(8, true);
    this.velocity.linear = dataView.getFloat32(12, true);
    this.velocity.angular = dataView.getFloat32(16, true);
  }

  /**
   * Create a copy of the current state.
   *
   * @returns A new State instance with the same values.
   */
  clone(): State {
    return new State(
      {
        position: { x: this.pose.position.x, y: this.pose.position.y },
        orientation: this.pose.orientation,
      },
      {
        linear: this.velocity.linear,
        angular: this.velocity.angular,
      }
    );
  }

  /**
   * Convert the state to a readable string representation
   *
   * @returns String representation of the state
   */
  toString(): string {
    return `State { pose: { position: { x: ${this.pose.position.x}, y: ${this.pose.position.y} }, orientation: ${this.pose.orientation} }, velocity: { linear: ${this.velocity.linear}, angular: ${this.velocity.angular} } }`;
  }
}
