import React, { useState, useEffect } from 'react';
import { useCommunication } from '@/hooks/useCommunication';
import Plot from 'react-plotly.js';

import { Layout } from 'plotly.js'; // Import Layout type

export function VariableChart() {
  const { pool } = useCommunication();
  const [revision, setRevision] = useState(0);
  const [lastDataLength, setLastDataLength] = useState(0);

  console.log('VariableChart rendered, revision:', revision);

  useEffect(() => {
    console.log('VariableChart mounted');

    // Check for data changes every 100ms, but only update revision when data actually changes
    const interval = setInterval(() => {
      const logs = pool.getVariableLogs(17);
      const currentLength = logs?.[0]?.length || 0;

      if (currentLength !== lastDataLength) {
        setLastDataLength(currentLength);
        setRevision((prev) => prev + 1);
      }
    }, 100);

    return () => {
      console.log('VariableChart unmounted');
      clearInterval(interval);
    };
  }, [pool, lastDataLength]);

  // Get logs once per render to avoid calling getVariableLogs multiple times
  const logs = pool.getVariableLogs(17);

  return (
    <div className="flex flex-col h-full">
      <Plot
        className="w-full h-full"
        data={[
          {
            // x: logs?.[0] || [],
            y: (logs?.[1] || []) as any,
            type: 'scattergl',
            mode: 'lines+markers',
          },
        ]}
        layout={
          {
            title: 'Variable Chart',
            datarevision: revision,
            uirevision: 'true',
          } as unknown as Layout
        }
        revision={revision}
      />
    </div>
  );
}
