import { useState } from 'react';

/** Whether the value has been true at any render so far, such as an overlay opened once. */
export function useEver(value: boolean): boolean {
  const [ever, setEver] = useState(value);

  if (value && !ever) {
    setEver(true);
  }

  return ever || value;
}
