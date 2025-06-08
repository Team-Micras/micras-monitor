import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Bluetooth, Plug, Wifi } from 'lucide-react';
import { useState } from 'react';
import { CommunicationControls } from './CommunicationControls';

type CommunicationMethod = 'bluetooth' | 'websocket';

export function TopBar() {
  const [selectedMethod, setSelectedMethod] = useState<CommunicationMethod>('websocket');

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      {/* Left side - Sidebar trigger */}
      <div className="flex items-center gap-4">
        <SidebarTrigger />
        <h1 className="text-lg font-semibold">Micras Monitor</h1>
      </div>

      {/* Center - Communication controls */}
      <div className="flex items-center gap-4">
        {/* Communication method selector */}
        <div className="flex items-center gap-2">
          <Select
            value={selectedMethod}
            onValueChange={(value: CommunicationMethod) => setSelectedMethod(value)}
          >
            <SelectTrigger className="w-36">
              <SelectValue>
                <div className="flex items-center gap-2">
                  {selectedMethod === 'bluetooth' ? (
                    <>
                      <Bluetooth className="h-4 w-4" />
                      <span>Bluetooth</span>
                    </>
                  ) : (
                    <>
                      <Plug className="h-4 w-4" />
                      <span>WebSocket</span>
                    </>
                  )}
                </div>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="websocket">
                <div className="flex items-center gap-2">
                  <Plug className="h-4 w-4" />
                  <span>WebSocket</span>
                </div>
              </SelectItem>
              <SelectItem value="bluetooth">
                <div className="flex items-center gap-2">
                  <Bluetooth className="h-4 w-4" />
                  <span>Bluetooth</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Communication controls */}
        <CommunicationControls selectedMethod={selectedMethod} />
      </div>
    </header>
  );
}
