import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/app';
import { createDemoRobot } from '@/app/fake/demo-robot';
import '@/app/styles.css';
import { RobotRegistry } from '@/robot-kit';
import { micras } from '@robots/micras';

const root = document.getElementById('root');

if (!root) {
  throw new Error('index.html has no #root element to mount the monitor in');
}

const robot = createDemoRobot();
const robots = new RobotRegistry([micras]);

createRoot(root).render(
  <StrictMode>
    <App ports={robot.ports} robots={robots} synthetic />
  </StrictMode>
);
