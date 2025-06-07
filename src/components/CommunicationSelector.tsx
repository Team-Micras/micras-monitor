import React, { useState } from 'react';
import { BluetoothCommunication } from './BluetoothCommunication';
import { WebSocketCommunication } from './WebSocketCommunication';

enum CommunicationType {
  BLUETOOTH,
  WEBSOCKET,
}

export const CommunicationSelector: React.FC = () => {
  const [communicationType, setCommunicationType] = useState<CommunicationType>(
    CommunicationType.BLUETOOTH
  );

  const handleCommunicationTypeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCommunicationType(parseInt(e.target.value) as CommunicationType);
  };

  return (
    <div className="communication-selector">
      <div className="selector-controls">
        <h3>Connection Method</h3>
        <div className="radio-group">
          <label>
            <input
              type="radio"
              name="communicationType"
              value={CommunicationType.BLUETOOTH}
              checked={communicationType === CommunicationType.BLUETOOTH}
              onChange={handleCommunicationTypeChange}
            />
            Bluetooth
          </label>
          <label>
            <input
              type="radio"
              name="communicationType"
              value={CommunicationType.WEBSOCKET}
              checked={communicationType === CommunicationType.WEBSOCKET}
              onChange={handleCommunicationTypeChange}
            />
            WebSocket
          </label>
        </div>
      </div>

      {communicationType === CommunicationType.BLUETOOTH ? (
        <BluetoothCommunication />
      ) : (
        <WebSocketCommunication />
      )}
    </div>
  );
};
