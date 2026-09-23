import { CommunicationProvider } from './contexts/CommunicationContext';
import { customSerializableClasses } from './types/serializables';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { TopBar } from '@/components/top-bar';
import { VariableChart } from './components/variable-chart';

function App() {
  return (
    <CommunicationProvider customSerializableClasses={customSerializableClasses}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <TopBar />
          <main className="flex-1 p-4">
            <VariableChart />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </CommunicationProvider>
  );
}

export default App;
