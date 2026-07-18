import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import "./home/waterfall.css";
import { WaterfallShell } from "./home/WaterfallShell";
import { parseInitialHomeFeed } from "./home/homeData";
import { API_BASE } from "./lib/apiBase";
import { createTelemetryBootstrap } from "./lib/telemetry/bootstrap";
import { installErrorHandlers } from "./lib/telemetry/errors";
import { EVENTS, initTelemetry, track } from "./lib/telemetry";
import {
  installApiTiming,
  installImgTiming,
  installNavTiming,
  installVitals,
} from "./lib/telemetry/vitals";

const initialDataElement = document.getElementById("aifeeds-initial-data");
const root = document.getElementById("root");
if (!initialDataElement?.textContent || !root) {
  throw new Error("Missing waterfall hydration data");
}
const initialData = parseInitialHomeFeed(initialDataElement.textContent);

try {
  createTelemetryBootstrap({
    endpoint: `${API_BASE}/api/track`,
    events: EVENTS,
    initTelemetry,
    installVitals,
    installNavTiming,
    installImgTiming,
    installApiTiming,
    installErrorHandlers,
    track,
    location: window.location,
    referrer: document.referrer,
  })();
} catch {
  // Telemetry remains non-blocking for hydration.
}

hydrateRoot(
  root,
  <StrictMode>
    <BrowserRouter>
      <WaterfallShell initialData={initialData} />
    </BrowserRouter>
  </StrictMode>,
);
