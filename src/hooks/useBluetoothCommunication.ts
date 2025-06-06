import { useState, useEffect, useCallback } from 'react';
import { useCommunication } from '../contexts/CommunicationContext';
import { BluetoothService } from '../lib/bluethooth/BluetoothService';

interface UseBluetoothCommunicationConfig {
  serviceUuid?: string;
  characteristicUuid?: string;
  autoStart?: boolean;
}

interface UseBluetoothCommunicationResult {
  bluetoothService: BluetoothService | null;
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
}: UseBluetoothCommunicationConfig = {}): UseBluetoothCommunicationResult => {
  const [bluetoothService, setBluetoothService] = useState<BluetoothService | null>(null);
  const [deviceName, setDeviceName] = useState<string>('No Device');
  const [isBluetoothConnected, setIsBluetoothConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const {
    registerCommunicationFunctions,
    startCommunication,
    stopCommunication,
    isConnected: isProtocolConnected,
  } = useCommunication();

  useEffect(() => {
    const service = new BluetoothService(serviceUuid, characteristicUuid, (connected) => {
      setIsBluetoothConnected(connected);
      if (connected) {
        setDeviceName(service.getDeviceName());
      } else {
        setDeviceName('No Device');
      }
    });

    setBluetoothService(service);

    return () => {
      if (service && service.isDeviceConnected()) {
        service.disconnect();
      }
    };
  }, [serviceUuid, characteristicUuid]);

  useEffect(() => {
    if (!bluetoothService) return;

    const sendData = async (data: Uint8Array): Promise<void> => {
      bluetoothService.sendData(data);
      return Promise.resolve();
    };

    const getData = async (): Promise<Uint8Array> => {
      return Promise.resolve(bluetoothService.getData());
    };

    registerCommunicationFunctions(sendData, getData);
  }, [bluetoothService, registerCommunicationFunctions]);

  useEffect(() => {
    if (isBluetoothConnected) {
      startCommunication();
    } else {
      stopCommunication();
    }
  }, [isBluetoothConnected, startCommunication, stopCommunication]);

  useEffect(() => {
    if (autoStart && bluetoothService && !isBluetoothConnected && !isConnecting) {
      connect();
    }
  }, [autoStart, bluetoothService]);

  const connect = useCallback(async () => {
    if (!bluetoothService) return;

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
    if (!bluetoothService) return;

    try {
      await bluetoothService.disconnect();
    } catch (err) {
      console.error('Error disconnecting from Bluetooth device:', err);
    }
  }, [bluetoothService]);

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
