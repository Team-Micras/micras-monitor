import React, { createContext, useContext, useCallback, useRef } from 'react';

type VariableChangeListener = (variableId: number) => void;

interface VariableChangeContextType {
  addListener: (variableId: number, listener: VariableChangeListener) => void;
  removeListener: (variableId: number, listener: VariableChangeListener) => void;
  notifyChange: (variableId: number) => void;
}

const VariableChangeContext = createContext<VariableChangeContextType | null>(null);

export function VariableChangeProvider({ children }: { children: React.ReactNode }) {
  const listenersRef = useRef<Map<number, Set<VariableChangeListener>>>(new Map());

  const addListener = useCallback(
    (variableId: number, listener: VariableChangeListener) => {
      const listeners = listenersRef.current;
      if (!listeners.has(variableId)) {
        listeners.set(variableId, new Set());
      }
      listeners.get(variableId)!.add(listener);
    },
    []
  );

  const removeListener = useCallback(
    (variableId: number, listener: VariableChangeListener) => {
      const listeners = listenersRef.current;
      const variableListeners = listeners.get(variableId);
      if (variableListeners) {
        variableListeners.delete(listener);
        if (variableListeners.size === 0) {
          listeners.delete(variableId);
        }
      }
    },
    []
  );

  const notifyChange = useCallback((variableId: number) => {
    const listeners = listenersRef.current;
    const variableListeners = listeners.get(variableId);
    if (variableListeners) {
      variableListeners.forEach((listener) => listener(variableId));
    }
  }, []);

  const value = {
    addListener,
    removeListener,
    notifyChange,
  };

  return (
    <VariableChangeContext.Provider value={value}>
      {children}
    </VariableChangeContext.Provider>
  );
}

export function useVariableChangeContext() {
  const context = useContext(VariableChangeContext);
  if (!context) {
    throw new Error(
      'useVariableChangeContext must be used within a VariableChangeProvider'
    );
  }
  return context;
}
