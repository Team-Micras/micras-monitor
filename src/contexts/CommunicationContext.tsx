import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
  CommunicationService,
  SendDataFunction,
  GetDataFunction,
} from '../lib/comm/CommunicationService';
import { SerialVariablePool, SerializableClasses } from '../lib/comm/SerialVariablePool';

interface CommunicationContextType {
  commService: CommunicationService | null;
  isConnected: boolean;
  registerCommunicationFunctions: (
    sendDataFunc: SendDataFunction,
    getDataFunc: GetDataFunction
  ) => void;
  startCommunication: () => void;
  stopCommunication: () => void;
  pool: SerialVariablePool | null;
}

const CommunicationContext = createContext<CommunicationContextType | undefined>(
  undefined
);

interface CommunicationProviderProps {
  children: ReactNode;
  customSerializableClasses?: SerializableClasses;
}

export const CommunicationProvider: React.FC<CommunicationProviderProps> = ({
  children,
  customSerializableClasses = {},
}) => {
  const [commService, setCommService] = useState<CommunicationService | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [pool, setPool] = useState<SerialVariablePool | null>(null);

  useEffect(() => {
    const pool = new SerialVariablePool(customSerializableClasses);
    const commService = new CommunicationService(pool, (status: boolean) => {
      setIsConnected(status);
      console.log(
        `CommunicationContext: Connection status changed: ${
          status ? 'Connected' : 'Disconnected'
        }`
      );
    });

    setCommService(commService);
    setPool(pool);
  }, [customSerializableClasses]);

  const registerCommunicationFunctions = (
    sendDataFunc: SendDataFunction,
    getDataFunc: GetDataFunction
  ) => {
    if (!commService) return;
    commService.registerCommunicationFunctions(sendDataFunc, getDataFunc);
  };

  const startCommunication = () => {
    if (!commService) return;
    commService.startCommunication();
  };

  const stopCommunication = () => {
    if (!commService) return;
    commService.stopCommunication();
  };

  const contextValue = {
    commService,
    isConnected,
    registerCommunicationFunctions,
    startCommunication,
    stopCommunication,
    pool,
  };

  return (
    <CommunicationContext.Provider value={contextValue}>
      {children}
    </CommunicationContext.Provider>
  );
};

export const useCommunication = () => {
  const context = useContext(CommunicationContext);
  if (!context) {
    throw new Error('useCommunication must be used within a CommunicationProvider');
  }
  return context;
};
