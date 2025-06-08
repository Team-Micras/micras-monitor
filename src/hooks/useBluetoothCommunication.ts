import { useState, useEffect, useCallback } from 'react';
import { useCommunication } from './useCommunication';
import { BluetoothService } from '@/lib/bluethooth/BluetoothService';

interface UseBluetoothCommunicationConfig {
  serviceUuid?: string;
  characteristicUuid?: string;
  autoStart?: boolean;
  enabled?: boolean; // New parameter to control hook registration
}

interface UseBluetoothCommunicationResult {
  bluetoothService: BluetoothService;
  isBluetoothConnected: boolean;
  isProtocolConnected: boolean;
  isConnecting: boolean;
  deviceName: string;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export const useBluetoothCommunication = ({
  serviceUuid,
  characteristicUuid,
  autoStart = false,
  enabled = true, // Default to enabled for backward compatibility
}: UseBluetoothCommunicationConfig = {}): UseBluetoothCommunicationResult => {
  const [deviceName, setDeviceName] = useState<string>('No Device');
  const [isBluetoothConnected, setIsBluetoothConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  console.log('useBluetoothCommunication init');

  const {
    registerCommunicationFunctions,
    startCommunication,
    stopCommunication,
    isConnected: isProtocolConnected,
  } = useCommunication();

  const [bluetoothService] = useState(() => {
    const service = new BluetoothService(serviceUuid, characteristicUuid, (connected) => {
      setIsBluetoothConnected(connected);
      if (connected) {
        setDeviceName(service.getDeviceName());
      } else {
        setDeviceName('No Device');
      }
    });
    return service;
  });

  useEffect(() => {
    return () => {
      if (bluetoothService.isDeviceConnected()) {
        bluetoothService.disconnect();
      }
    };
  }, [bluetoothService]);

  useEffect(() => {
    // Only register if this hook is enabled
    if (!enabled) return;

    const sendData = async (data: Uint8Array): Promise<void> => {
      bluetoothService.sendData(data);
      return Promise.resolve();
    };

    const getData = async (): Promise<Uint8Array> => {
      return Promise.resolve(bluetoothService.getData());
    };

    registerCommunicationFunctions(sendData, getData);
  }, [bluetoothService, registerCommunicationFunctions, enabled]);

  useEffect(() => {
    // Only auto-start/manage protocol if enabled
    if (!enabled) return;

    if (isBluetoothConnected) {
      startCommunication();
    } else if (isProtocolConnected) {
      stopCommunication();
    }
  }, [
    isBluetoothConnected,
    isProtocolConnected,
    startCommunication,
    stopCommunication,
    enabled,
  ]);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      await bluetoothService.connect();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
      setError(errorMessage);
      console.error('Failed to connect to Bluetooth device:', err);
    } finally {
      setIsConnecting(false);
    }
  }, [bluetoothService]);

  const disconnect = useCallback(async () => {
    try {
      await bluetoothService.disconnect();
    } catch (err) {
      console.error('Error disconnecting from Bluetooth device:', err);
    }
  }, [bluetoothService]);

  useEffect(() => {
    if (autoStart && bluetoothService && !isBluetoothConnected && !isConnecting) {
      connect();
    }
  }, [autoStart, bluetoothService, isBluetoothConnected, isConnecting, connect]);

  return {
    bluetoothService,
    isBluetoothConnected,
    isProtocolConnected,
    isConnecting,
    deviceName,
    error,
    connect,
    disconnect,
  };
};
