import { Button } from '@/components/ui/button';
import { Circle, Loader2, X, Bluetooth, Wifi } from 'lucide-react';
import { useBluetoothCommunication } from '@/hooks/useBluetoothCommunication';
import { useWebSocketCommunication } from '@/hooks/useWebSocketCommunication';
import { cn } from '@/lib/utils';

type CommunicationMethod = 'bluetooth' | 'websocket';

interface CommunicationControlsProps {
  selectedMethod: CommunicationMethod;
}

export function CommunicationControls({ selectedMethod }: CommunicationControlsProps) {
  // Only enable the hook for the currently selected method to avoid conflicts
  const bluetoothHook = useBluetoothCommunication({
    autoStart: false,
    enabled: selectedMethod === 'bluetooth',
  });

  const webSocketHook = useWebSocketCommunication({
    url: 'ws://localhost:8080',
    autoStart: false,
    enabled: selectedMethod === 'websocket',
  });

  // Select the appropriate hook data based on current method
  const currentHook = selectedMethod === 'bluetooth' ? bluetoothHook : webSocketHook;
  const isTransportConnected =
    selectedMethod === 'bluetooth'
      ? bluetoothHook.isBluetoothConnected
      : webSocketHook.isWebSocketConnected;
  const isConnecting = currentHook.isConnecting;
  const isProtocolConnected = currentHook.isProtocolConnected;
  const deviceInfo =
    selectedMethod === 'bluetooth' ? bluetoothHook.deviceName : webSocketHook.serverUrl;
  const error = currentHook.error;

  // Wrap the connect functions to handle different signatures
  const handleConnect = async () => {
    if (selectedMethod === 'bluetooth') {
      await bluetoothHook.connect();
    } else {
      await webSocketHook.connect();
    }
  };

  const handleDisconnect = async () => {
    if (selectedMethod === 'bluetooth') {
      await bluetoothHook.disconnect();
    } else {
      await webSocketHook.disconnect();
    }
  };

  const getStatusIndicator = (isConnected: boolean, label: string) => (
    <div className="flex items-center gap-1 text-xs">
      <Circle
        className={cn(
          'h-2 w-2 fill-current',
          isConnected ? 'text-green-500' : 'text-red-500'
        )}
      />
      <span className="text-muted-foreground">{label}</span>
    </div>
  );

  const transportLabel = selectedMethod === 'bluetooth' ? 'Bluetooth' : 'WebSocket';
  const ConnectIcon = selectedMethod === 'bluetooth' ? Bluetooth : Wifi;

  return (
    <>
      {/* Connect/Disconnect button */}
      <Button
        onClick={isTransportConnected ? handleDisconnect : handleConnect}
        disabled={isConnecting}
        variant={isTransportConnected ? 'destructive' : 'default'}
        size="sm"
      >
        {isConnecting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Connecting...
          </>
        ) : isTransportConnected ? (
          <>Disconnect</>
        ) : (
          <>Connect</>
        )}
      </Button>

      {/* Connection status indicators */}
      <div className="flex items-center gap-3 pl-2 border-l">
        {getStatusIndicator(isTransportConnected, transportLabel)}
        {getStatusIndicator(isProtocolConnected, 'Protocol')}
      </div>

      {/* Device info */}
      {isTransportConnected && deviceInfo && (
        <div className="text-xs text-muted-foreground">{deviceInfo}</div>
      )}

      {/* Error display */}
      {error && (
        <div className="text-xs text-red-500 max-w-48 truncate">Error: {error}</div>
      )}
    </>
  );
}
