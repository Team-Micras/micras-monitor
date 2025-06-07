import { useState, useEffect, useRef, useCallback } from 'react';
import type { ISerialVariable } from '@/lib/comm/variables/ISerialVariable';
import { useVariableChangeContext } from '@/contexts/VariableChangeContext';

/**
 * Custom hook to track individual variable value changes
 * This helps prevent unnecessary re-renders by only updating when the specific variable changes
 */
export function useVariableValue(serialVariable: ISerialVariable, variableId: number) {
  const [value, setValue] = useState(() => serialVariable.getReference().value);
  const [name] = useState(() => serialVariable.getName());
  const [type] = useState(() => serialVariable.getType());
  const [readOnly] = useState(() => serialVariable.isReadOnly());

  const serialVariableRef = useRef(serialVariable);
  serialVariableRef.current = serialVariable;

  const { addListener, removeListener } = useVariableChangeContext();

  const handleVariableChange = useCallback(() => {
    const currentValue = serialVariableRef.current.getReference().value;
    setValue(currentValue);
  }, []);

  useEffect(() => {
    addListener(variableId, handleVariableChange);

    return () => {
      removeListener(variableId, handleVariableChange);
    };
  }, [variableId, addListener, removeListener, handleVariableChange]);

  return {
    value,
    name,
    type,
    readOnly,
  };
}
