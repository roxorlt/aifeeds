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
    deps.initTelemetry({ endpoint: deps.endpoint });
    deps.installErrorHandlers();
    deps.installVitals();
    deps.installNavTiming();
    deps.installImgTiming();
    deps.installApiTiming();

    const params = new URLSearchParams(deps.location.search);
    deps.track(deps.events.APP_OPEN, {
      utm_source: params.get('utm_source') || undefined,
      utm_campaign: params.get('utm_campaign') || undefined,
      referrer: deps.referrer || undefined,
    });
    deps.track(deps.events.PAGE_VIEW, {
      path: deps.location.pathname + deps.location.search,
    });
  };
}
