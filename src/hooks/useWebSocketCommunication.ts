import { useState, useEffect, useCallback } from 'react';
import { useCommunication } from './useCommunication';
import { WebSocketService } from '@/lib/websocket/WebSocketService';

interface UseWebSocketCommunicationConfig {
  url?: string;
  autoStart?: boolean;
}

interface UseWebSocketCommunicationResult {
  webSocketService: WebSocketService;
  isWebSocketConnected: boolean;
  isProtocolConnected: boolean;
  isConnecting: boolean;
  serverUrl: string;
  error: string | null;
  connect: (customUrl?: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

export const useWebSocketCommunication = ({
  url = 'ws://localhost:8080',
  autoStart = false,
}: UseWebSocketCommunicationConfig = {}): UseWebSocketCommunicationResult => {
  const [serverUrl, setServerUrl] = useState<string>(url);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  console.log('useWebSocketCommunication init');

  const {
    registerCommunicationFunctions,
    startCommunication,
    stopCommunication,
    isConnected: isProtocolConnected,
  } = useCommunication();

  const [webSocketService] = useState(() => {
    const service = new WebSocketService(url, (connected) => {
      setIsWebSocketConnected(connected);
      if (connected) {
        setServerUrl(service.getServerUrl());
      }
    });
    return service;
  });

  useEffect(() => {
    return () => {
      if (webSocketService.isDeviceConnected()) {
        webSocketService.disconnect();
      }
    };
  }, [webSocketService]);

  useEffect(() => {
    if (!webSocketService) return;

    const sendData = async (data: Uint8Array): Promise<void> => {
      webSocketService.sendData(data);
      return Promise.resolve();
    };

    const getData = async (): Promise<Uint8Array> => {
      return Promise.resolve(webSocketService.getData());
    };

    registerCommunicationFunctions(sendData, getData);
  }, [webSocketService, registerCommunicationFunctions]);

  useEffect(() => {
    if (isWebSocketConnected) {
      startCommunication();
    } else if (isProtocolConnected) {
      stopCommunication();
    }
  }, [isWebSocketConnected, isProtocolConnected, startCommunication, stopCommunication]);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    // @TODO handle custom URL logic (customUrl?: string)
    // let serviceToUse = webSocketService;
    // if (customUrl && customUrl !== url) {
    //   serviceToUse = new WebSocketService(customUrl, (connected) => {
    //     setIsWebSocketConnected(connected);
    //     if (connected) {
    //       setServerUrl(customUrl);
    //     }
    //   });
    //   setWebSocketService(serviceToUse);
    // }

    try {
      await webSocketService.connect();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
      setError(errorMessage);
      console.error('Failed to connect to WebSocket server:', err);
    } finally {
      setIsConnecting(false);
    }
  }, [webSocketService]);

  const disconnect = useCallback(async () => {
    try {
      await webSocketService.disconnect();
    } catch (err) {
      console.error('Error disconnecting from WebSocket server:', err);
    }
  }, [webSocketService]);

  useEffect(() => {
    if (autoStart && webSocketService && !isWebSocketConnected && !isConnecting) {
      connect();
    }
  }, [autoStart, webSocketService, isWebSocketConnected, isConnecting, connect]);

  return {
    webSocketService,
    isWebSocketConnected,
    isProtocolConnected,
    isConnecting,
    serverUrl,
    error,
    connect,
    disconnect,
  };
};
