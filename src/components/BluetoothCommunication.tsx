import React, { useState, useEffect, useCallback } from 'react';
import { useCommunication } from '../contexts/CommunicationContext';
import { BluetoothService } from '../lib/bluethooth/BluetoothService';

interface BluetoothCommunicationProps {
  serviceUuid?: string;
  characteristicUuid?: string;
}

export const BluetoothCommunication: React.FC<BluetoothCommunicationProps> = ({
  serviceUuid,
  characteristicUuid,
}) => {
  const [bluetoothService, setBluetoothService] = useState<BluetoothService | null>(null);
  const [deviceName, setDeviceName] = useState<string>('No Device');
  const [isBluetoothConnected, setIsBluetoothConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  
  const { 
    registerCommunicationFunctions, 
    startCommunication, 
    stopCommunication, 
    isConnected: isProtocolConnected 
  } = useCommunication();

  useEffect(() => {
    const service = new BluetoothService(
      serviceUuid,
      characteristicUuid,
      (connected) => {
        setIsBluetoothConnected(connected);
        if (connected) {
          setDeviceName(service.getDeviceName());
        } else {
          setDeviceName('No Device');
        }
      }
    );
    
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

  const handleConnect = useCallback(async () => {
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

  const handleDisconnect = useCallback(async () => {
    if (!bluetoothService) return;
    
    try {
      await bluetoothService.disconnect();
    } catch (err) {
      console.error('Error disconnecting from Bluetooth device:', err);
    }
  }, [bluetoothService]);

  return (
    <div className="bluetooth-communication">
      <div className="connection-status">
        <h3>Connection Status</h3>
        <p>
          <strong>Bluetooth:</strong> {isBluetoothConnected ? 'Connected' : 'Disconnected'}
          {isBluetoothConnected && ` (${deviceName})`}
        </p>
        <p>
          <strong>Protocol:</strong> {isProtocolConnected ? 'Connected' : 'Disconnected'}
        </p>
      </div>
      
      <div className="connection-controls">
        {!isBluetoothConnected ? (
          <button 
            onClick={handleConnect} 
            disabled={isConnecting || !bluetoothService}
          >
            {isConnecting ? 'Connecting...' : 'Connect to Device'}
          </button>
        ) : (
          <button 
            onClick={handleDisconnect} 
            disabled={!bluetoothService}
          >
            Disconnect
          </button>
        )}
      </div>
      
      {error && (
        <div className="error-message">
          <p>Error: {error}</p>
        </div>
      )}
    </div>
  );
};