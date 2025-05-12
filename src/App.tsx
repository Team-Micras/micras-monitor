import './App.css'
import { CommunicationProvider } from './contexts/CommunicationContext'
import { CommunicationSelector } from './components/CommunicationSelector'
import { VariablesMonitor } from './components/VariablesMonitor'

function App() {
  return (
    <CommunicationProvider>
      <div className="app">
        <header className="app-header">
          <h1>Micras Monitor</h1>
        </header>
        <main>
          <CommunicationSelector />
          <VariablesMonitor />
        </main>
      </div>
    </CommunicationProvider>
  )
}

export default App
