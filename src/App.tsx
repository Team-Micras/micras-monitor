import { useState } from 'react'
import './App.css'
import { CommunicationProvider } from './contexts/CommunicationContext'
import { BluetoothCommunication } from './components/BluetoothCommunication'

function App() {

  return (
      <CommunicationProvider>
        <div className="app">
          <header className="app-header">
            <h1>Micras Monitor</h1>
          </header>
          <main>
            <BluetoothCommunication />
          </main>
        </div>
      </CommunicationProvider>
  )
}

export default App
