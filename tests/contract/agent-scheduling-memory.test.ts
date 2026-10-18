import { describeAgentSchedulingScenarios } from './agent-scheduling.scenarios.js';

// The composition root builds the in-memory system from settings, as `npm run dev` does by default.
describeAgentSchedulingScenarios('memory', () => ({ env: { MUJEEB_SCHEDULING_PROVIDER: 'memory' } }));
