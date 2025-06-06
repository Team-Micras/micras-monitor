import { CommunicationProvider } from './contexts/CommunicationContext'
import { CommunicationSelector } from './components/CommunicationSelector'
import { VariablesMonitor } from './components/VariablesMonitor'
import { customSerializableClasses } from './types'

function App() {
  return (
    <CommunicationProvider customSerializableClasses={customSerializableClasses}>
      <div>
        <header>
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
