import { createContext, useState, useMemo, useCallback, ReactNode } from 'react';
import { SerialVariablePool, SerializableClasses } from '@/lib/comm/SerialVariablePool';
import {
  CommunicationService,
  SendDataFunction,
  GetDataFunction,
} from '@/lib/comm/CommunicationService';

interface CommunicationContextType {
  commService: CommunicationService | null;
  isConnected: boolean;
  registerCommunicationFunctions: (
    sendDataFunc: SendDataFunction,
    getDataFunc: GetDataFunction
  ) => void;
  startCommunication: () => void;
  stopCommunication: () => void;
  pool: SerialVariablePool;
}

const CommunicationContext = createContext<CommunicationContextType | undefined>(
  undefined
);

export { CommunicationContext };

interface CommunicationProviderProps {
  children: ReactNode;
  customSerializableClasses?: SerializableClasses;
}

export const CommunicationProvider: React.FC<CommunicationProviderProps> = ({
  children,
  customSerializableClasses = {},
}) => {
  const [isConnected, setIsConnected] = useState<boolean>(false);

  const pool = useMemo(() => {
    console.log(
      'Creating SerialVariablePool with customSerializableClasses:',
      customSerializableClasses
    );
    return new SerialVariablePool(customSerializableClasses);
  }, [customSerializableClasses]);

  const commService = useMemo(() => {
    console.log('Creating CommunicationService with pool:', pool);
    return new CommunicationService(pool, (status: boolean) => {
      setIsConnected(status);
      console.log(
        `CommunicationContext: Connection status changed: ${
          status ? 'Connected' : 'Disconnected'
        }`
      );
    });
  }, [pool]);

  const registerCommunicationFunctions = useCallback(
    (sendDataFunc: SendDataFunction, getDataFunc: GetDataFunction) => {
      commService.registerCommunicationFunctions(sendDataFunc, getDataFunc);
    },
    [commService]
  );

  const startCommunication = useCallback(() => {
    commService.startCommunication();
  }, [commService]);

  const stopCommunication = useCallback(() => {
    commService.stopCommunication();
  }, [commService]);

  const contextValue = useMemo(
    () => ({
      commService,
      isConnected,
      registerCommunicationFunctions,
      startCommunication,
      stopCommunication,
      pool,
    }),
    [
      commService,
      isConnected,
      registerCommunicationFunctions,
      startCommunication,
      stopCommunication,
      pool,
    ]
  );

  return (
    <CommunicationContext.Provider value={contextValue}>
      {children}
    </CommunicationContext.Provider>
  );
};
