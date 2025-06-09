import React, { useState, useEffect } from 'react';
import { useCommunication } from '@/hooks/useCommunication';
import Plot from 'react-plotly.js';

import { Layout } from 'plotly.js'; // Import Layout type

export function VariableChart() {
  const { pool } = useCommunication();
  const [revision, setRevision] = useState(0);
  const variablesIds: number[] = [8, 21, 11, 12, 13, 14, 15, 16, 18, 17];

  console.log('VariableChart rendered, revision:', revision);

  useEffect(() => {
    console.log('VariableChart mounted');

    // Check for data changes every 100ms, but only update revision when data actually changes
    const interval = setInterval(() => {
      setRevision((prev) => prev + 1);
    }, 100);

    return () => {
      console.log('VariableChart unmounted');
      clearInterval(interval);
    };
  }, [pool]);

  return (
    <div className="flex flex-col h-full">
      <Plot
        className="w-full h-full"
        data={variablesIds.map((id) => ({
          // x: pool.getVariableLogs(id)?.[0] || [],
          y: (pool.getVariableLogs(id)?.[1] || []) as any,
          type: 'scattergl' as const,
          mode: 'lines' as const,
          name: `Variable ${id}`, // Add a name for the legend
        }))}
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
