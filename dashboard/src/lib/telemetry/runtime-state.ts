export type TelemetryRuntimeState = 'idle' | 'initializing' | 'ready' | 'disabled';

export interface TelemetryLifecycle {
  initialize: (initializer: () => void) => boolean;
  runIfReady: (work: () => void) => boolean;
  state: () => TelemetryRuntimeState;
}

export function createTelemetryLifecycle(): TelemetryLifecycle {
  let current: TelemetryRuntimeState = 'idle';

  return {
    initialize(initializer) {
      if (current === 'ready') return true;
      if (current !== 'idle') return false;
      current = 'initializing';
      try {
        initializer();
        current = 'ready';
        return true;
      } catch (error) {
        current = 'disabled';
        throw error;
      }
    },
    runIfReady(work) {
      if (current !== 'ready') return false;
      try {
        work();
        return true;
      } catch {
        // Telemetry is ancillary. A queue/session/browser failure must never escape
        // into product interactions; disable the damaged runtime for this page.
        current = 'disabled';
        return false;
      }
    },
    state() {
      return current;
    },
  };
}
