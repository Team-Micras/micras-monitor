/**
 * The root of the monitor. Until the shell lands it only says that the application is being
 * rebuilt.
 */
export function App() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <img src="/micras_monitor_logo.svg" alt="" className="size-16" />
        <h1 className="text-2xl font-semibold tracking-tight">Micras Monitor</h1>
        <p className="font-mono text-sm text-muted-foreground">em reconstrução</p>
      </div>
    </main>
  );
}
