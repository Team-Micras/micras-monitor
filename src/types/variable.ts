import { ISerialVariable } from '@/lib/comm/variables/ISerialVariable';

export interface Variable {
  /**
   * Current value of the variable.
   */
  serialVariable: { value: ISerialVariable };

  /**
   * Unique identifier for the variable.
   */
  id: number;

  /**
   * Indicates if the variable is being transmitted from the remote side.
   */
  isEnabled: boolean;

  /**
   * Optional color associated with the variable, used for visualization.
   */
  color: string;
}
