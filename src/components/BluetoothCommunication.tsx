import { useBluetoothCommunication } from '@/hooks/useBluetoothCommunication';
import React from 'react';

interface BluetoothCommunicationProps {
  serviceUuid?: string;
  characteristicUuid?: string;
}

export const BluetoothCommunication: React.FC<BluetoothCommunicationProps> = ({
  serviceUuid,
  characteristicUuid,
}) => {
  const {
    isBluetoothConnected,
    isProtocolConnected,
    isConnecting,
    deviceName,
    error,
    connect,
    disconnect,
  } = useBluetoothCommunication({
    serviceUuid,
    characteristicUuid,
  });

  console.log(
    'BluetoothCommunication component initialized with serviceUuid:',
    serviceUuid,
    'characteristicUuid:',
    characteristicUuid
  );

  return (
    <div className="bluetooth-communication">
      <div className="connection-status">
        <h3>Connection Status</h3>
        <p>
          <strong>Bluetooth:</strong>{' '}
          {isBluetoothConnected ? 'Connected' : 'Disconnected'}
          {isBluetoothConnected && ` (${deviceName})`}
        </p>
        <p>
          <strong>Protocol:</strong> {isProtocolConnected ? 'Connected' : 'Disconnected'}
        </p>
      </div>

      <div className="connection-controls">
        {!isBluetoothConnected ? (
          <button onClick={connect} disabled={isConnecting}>
            {isConnecting ? 'Connecting...' : 'Connect to Device'}
          </button>
        ) : (
          <button onClick={disconnect}>Disconnect</button>
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
