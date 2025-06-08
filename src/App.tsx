import { CommunicationProvider } from './contexts/CommunicationContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { customSerializableClasses } from './types/serializables';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { TopBar } from '@/components/top-bar';
import { VariablesMonitor } from './components/VariablesMonitor';
import { VariableChart } from './components/variable-chart';

function App() {
  return (
    <ThemeProvider>
      <CommunicationProvider customSerializableClasses={customSerializableClasses}>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <TopBar />
            <main className="flex-1 p-4">
              <VariablesMonitor />
              <VariableChart />
            </main>
          </SidebarInset>
        </SidebarProvider>
      </CommunicationProvider>
    </ThemeProvider>
  );
}

export default App;
