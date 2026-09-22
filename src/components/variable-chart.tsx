import { useEffect, useState } from 'react';
import Plot from 'react-plotly.js';
import { Layout } from 'plotly.js';

import { useCommunication } from '@/hooks/useCommunication';

/**
 * Every streamed variable, against the time the robot captured it at.
 *
 * The x axis is the robot's own timestamp, not the moment the browser happened to parse the
 * sample. Every variable of a group is captured in the same control loop iteration and carries one
 * timestamp for all of them, so two signals plotted here line up the way they did on the robot.
 */
export function VariableChart() {
  const { pool, isConnected } = useCommunication();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setRevision((previous) => previous + 1), 100);
    return () => clearInterval(interval);
  }, [pool]);

  const traces: Plotly.Data[] = [];

  pool.forEach((variable, id) => {
    const logs = pool.getVariableLogs(id);

    if (!logs || logs[0].length === 0) {
      return;
    }

    traces.push({
      x: logs[0].map((timestampMs) => timestampMs / 1000),
      y: logs[1] as number[],
      type: 'scattergl',
      mode: 'lines',
      name: variable.getName(),
    });
  });

  return (
    <div className="flex flex-col h-full">
      <Plot
        className="w-full h-full"
        data={traces}
        layout={
          {
            title: isConnected ? 'Telemetry' : 'Telemetry (disconnected)',
            xaxis: { title: 'Robot time (s)' },
            yaxis: { title: 'Value' },
            datarevision: revision,
            uirevision: 'true',
          } as unknown as Layout
        }
        revision={revision}
      />
    </div>
  );
}
