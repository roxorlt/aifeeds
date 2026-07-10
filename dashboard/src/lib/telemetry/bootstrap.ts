interface TelemetryBootstrapEvents {
  APP_OPEN: string;
  PAGE_VIEW: string;
  [key: string]: string;
}

interface TelemetryBootstrapDependencies {
  endpoint: string;
  events: TelemetryBootstrapEvents;
  initTelemetry: (options: { endpoint: string }) => void;
  installVitals: () => unknown;
  installNavTiming: () => unknown;
  installImgTiming: () => unknown;
  installApiTiming: () => unknown;
  installErrorHandlers: () => unknown;
  track: (type: string, payload?: Record<string, unknown>) => void;
  location: { pathname: string; search: string };
  referrer: string;
}

export function createTelemetryBootstrap(deps: TelemetryBootstrapDependencies): () => void {
  let installed = false;
  return () => {
    if (installed) return;
    installed = true;

    // Queue/session must exist before buffered Resource Timing can replay immediately.
    // If init itself fails, the page's telemetry is disabled: observers must never
    // replay into a queue/session that was not successfully initialized.
    try {
      deps.initTelemetry({ endpoint: deps.endpoint });
    } catch {
      return;
    }

    // Monitoring is strictly fail-open for the product UI. Each optional observer is
    // isolated so one unsupported/browser-buggy API cannot suppress the others.
    for (const install of [
      deps.installErrorHandlers,
      deps.installVitals,
      deps.installNavTiming,
      deps.installImgTiming,
      deps.installApiTiming,
    ]) {
      try {
        install();
      } catch {
        // Best-effort telemetry only; never block React startup.
      }
    }

    const params = new URLSearchParams(deps.location.search);
    try {
      deps.track(deps.events.APP_OPEN, {
        utm_source: params.get('utm_source') || undefined,
        utm_campaign: params.get('utm_campaign') || undefined,
        referrer: deps.referrer || undefined,
      });
    } catch {
      // Keep the independent page_view attempt and the app startup alive.
    }
    try {
      deps.track(deps.events.PAGE_VIEW, {
        path: deps.location.pathname + deps.location.search,
      });
    } catch {
      // Best-effort telemetry only; never block React startup.
    }
  };
}
