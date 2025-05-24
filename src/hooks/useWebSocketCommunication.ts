import { useState, useEffect, useCallback } from "react";
import { useCommunication } from "../contexts/CommunicationContext";
import { WebSocketService } from "../lib/websocket/WebSocketService";

interface UseWebSocketCommunicationConfig {
  url?: string;
  autoStart?: boolean;
}

interface UseWebSocketCommunicationResult {
  webSocketService: WebSocketService | null;
  isWebSocketConnected: boolean;
  isProtocolConnected: boolean;
  isConnecting: boolean;
  serverUrl: string;
  error: string | null;
  connect: (customUrl?: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

export const useWebSocketCommunication = ({
  url = "ws://localhost:8080",
  autoStart = false,
}: UseWebSocketCommunicationConfig = {}): UseWebSocketCommunicationResult => {
  const [webSocketService, setWebSocketService] =
    useState<WebSocketService | null>(null);
  const [serverUrl, setServerUrl] = useState<string>(url);
  const [isWebSocketConnected, setIsWebSocketConnected] =
    useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const {
    registerCommunicationFunctions,
    startCommunication,
    stopCommunication,
    isConnected: isProtocolConnected,
  } = useCommunication();

  useEffect(() => {
    const service = new WebSocketService(url, (connected) => {
      setIsWebSocketConnected(connected);
      if (connected) {
        setServerUrl(service.getServerUrl());
      }
    });

    setWebSocketService(service);

    return () => {
      if (service && service.isDeviceConnected()) {
        service.disconnect();
      }
    };
  }, [url]);

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
    } else {
      stopCommunication();
    }
  }, [isWebSocketConnected, startCommunication, stopCommunication]);

  useEffect(() => {
    if (
      autoStart &&
      webSocketService &&
      !isWebSocketConnected &&
      !isConnecting
    ) {
      connect();
    }
  }, [autoStart, webSocketService]);

  const connect = useCallback(
    async (customUrl?: string) => {
      if (!webSocketService) return;

      setIsConnecting(true);
      setError(null);

      let serviceToUse = webSocketService;
      if (customUrl && customUrl !== url) {
        serviceToUse = new WebSocketService(customUrl, (connected) => {
          setIsWebSocketConnected(connected);
          if (connected) {
            setServerUrl(customUrl);
          }
        });
        setWebSocketService(serviceToUse);
      }

      try {
        await serviceToUse.connect();
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error occurred";
        setError(errorMessage);
        console.error("Failed to connect to WebSocket server:", err);
      } finally {
        setIsConnecting(false);
      }
    },
    [webSocketService, url]
  );

  const disconnect = useCallback(async () => {
    if (!webSocketService) return;

    try {
      await webSocketService.disconnect();
    } catch (err) {
      console.error("Error disconnecting from WebSocket server:", err);
    }
  }, [webSocketService]);

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
