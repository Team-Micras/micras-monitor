import { CommunicationProvider } from './contexts/CommunicationContext';
import { customSerializableClasses } from './types/serializables';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { CommunicationSelector } from './components/CommunicationSelector';
import { VariablesMonitor } from './components/VariablesMonitor';

function App() {
  return (
    <CommunicationProvider customSerializableClasses={customSerializableClasses}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarTrigger />
        <div>
          <header>
            <h1>Micras Monitor</h1>
          </header>
          <main>
            <CommunicationSelector />
            <VariablesMonitor />
          </main>
        </div>
      </SidebarProvider>
    </CommunicationProvider>
  );
}

export default App;
