import React, { useState, useCallback } from 'react';
import { useWebSocketCommunication } from '../hooks/useWebSocketCommunication';

interface WebSocketCommunicationProps {
  url?: string;
}

export const WebSocketCommunication: React.FC<WebSocketCommunicationProps> = ({
  url = "ws://localhost:8080",
}) => {
  const [customUrl, setCustomUrl] = useState<string>(url);
  
  const { 
    webSocketService,
    isWebSocketConnected,
    isProtocolConnected, 
    isConnecting,
    serverUrl,
    error,
    connect,
    disconnect
  } = useWebSocketCommunication({ url });

  const handleConnect = useCallback(async () => {
    await connect(customUrl);
  }, [connect, customUrl]);

  const handleDisconnect = useCallback(async () => {
    await disconnect();
  }, [disconnect]);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCustomUrl(e.target.value);
  };

  return (
    <div className="websocket-communication">
      <div className="connection-status">
        <h3>WebSocket Connection</h3>
        <p>
          <strong>WebSocket:</strong> {isWebSocketConnected ? 'Connected' : 'Disconnected'}
          {isWebSocketConnected && ` (${serverUrl})`}
        </p>
        <p>
          <strong>Protocol:</strong> {isProtocolConnected ? 'Connected' : 'Disconnected'}
        </p>
      </div>
      
      <div className="connection-controls">
        <div className="url-input">
          <input 
            type="text" 
            value={customUrl} 
            onChange={handleUrlChange} 
            placeholder="WebSocket URL (e.g., ws://localhost:8080)"
            disabled={isWebSocketConnected}
          />
        </div>
        
        {!isWebSocketConnected ? (
          <button 
            onClick={handleConnect} 
            disabled={isConnecting || !webSocketService}
          >
            {isConnecting ? 'Connecting...' : 'Connect to WebSocket'}
          </button>
        ) : (
          <button 
            onClick={handleDisconnect} 
            disabled={!webSocketService}
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