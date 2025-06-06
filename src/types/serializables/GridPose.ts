import { ISerializable } from "@/lib/comm/ISerializable";

/**
 * Side enum representing cardinal directions
 * Equivalent to C++ enum Side : uint8_t
 */
export enum Side {
  RIGHT = 0,
  UP = 1,
  LEFT = 2,
  DOWN = 3,
}

/**
 * Grid position interface representing integer coordinates
 */
export interface GridPosition {
  x: number;
  y: number;
}

/**
 * GridPose class representing a discrete grid position and orientation
 * Implements ISerializable for communication with C++ counterpart
 */
export class GridPose implements ISerializable {
  public position: GridPosition;
  public orientation: Side;

  constructor(
    position: GridPosition = { x: 0, y: 0 },
    orientation: Side = Side.RIGHT
  ) {
    this.position = position;
    this.orientation = orientation;
  }

  /**
   * Serialize the GridPose instance to match C++ serialization format
   * Serializes: position.x, position.y, orientation
   * Each value is cast to uint8_t equivalent (0-255)
   *
   * @returns Serialized data as Uint8Array (3 bytes)
   */
  serialize(): Uint8Array {
    const serialData = new Uint8Array(3);

    serialData[0] = Math.max(0, Math.min(255, Math.round(this.position.x)));
    serialData[1] = Math.max(0, Math.min(255, Math.round(this.position.y)));
    serialData[2] = this.orientation;

    return serialData;
  }

  /**
   * Deserialize the GridPose instance from serialized data to match C++ deserialization
   * Expected format: position.x, position.y, orientation
   *
   * @param serialData Serialized data as Uint8Array (must be exactly 3 bytes)
   */
  deserialize(serialData: Uint8Array): void {
    if (serialData.length !== 3) {
      return;
    }

    this.position.x = serialData[0];
    this.position.y = serialData[1];
    const orientationValue = serialData[2];

    if (orientationValue >= 0 && orientationValue <= 3) {
      this.orientation = orientationValue as Side;
    } else {
      this.orientation = Side.RIGHT;
    }
  }

  /**
   * Create a copy of the current grid pose
   *
   * @returns A new GridPose instance with the same values
   */
  clone(): GridPose {
    return new GridPose(
      { x: this.position.x, y: this.position.y },
      this.orientation
    );
  }

  /**
   * Get the string representation of the current orientation
   *
   * @returns String name of the orientation
   */
  getOrientationString(): string {
    switch (this.orientation) {
      case Side.RIGHT:
        return "RIGHT";
      case Side.UP:
        return "UP";
      case Side.LEFT:
        return "LEFT";
      case Side.DOWN:
        return "DOWN";
      default:
        return "UNKNOWN";
    }
  }

  /**
   * Convert the grid pose to a readable string representation
   *
   * @returns String representation of the grid pose
   */
  toString(): string {
    return `GridPose { position: { x: ${this.position.x}, y: ${
      this.position.y
    } }, orientation: ${this.getOrientationString()} }`;
  }

  /**
   * Check if this grid pose is equal to another grid pose
   *
   * @param other The other GridPose to compare with
   * @returns True if positions and orientations are equal
   */
  equals(other: GridPose): boolean {
    return (
      this.position.x === other.position.x &&
      this.position.y === other.position.y &&
      this.orientation === other.orientation
    );
  }
}
