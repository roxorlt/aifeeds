export const DEFERRED_FONT_FALLBACK_MS = 10_000;
const DEFERRED_FONT_IDLE_TIMEOUT_MS = 3_000;
const DEFERRED_FONT_TIMER_IDLE_MS = 300;

export const DEFERRED_FONT_STYLESHEET_URLS = Object.freeze([
  "https://fonts.ai-feeds.com/hmos-regular/result.css",
  "https://fonts.ai-feeds.com/hmos-medium/result.css",
  "https://fonts.ai-feeds.com/hmos-bold/result.css",
]);

type FontConnection = {
  saveData?: boolean;
  effectiveType?: string;
};

type WorkHandle = unknown;

export type DeferredFontEnvironment = {
  target: EventTarget;
  getReadyState: () => string;
  readConnection: () => FontConnection | undefined;
  setTimer: (callback: () => void, delay: number) => WorkHandle;
  clearTimer: (handle: WorkHandle) => void;
  scheduleIdle: (callback: () => void, timeout: number) => WorkHandle;
  cancelIdle: (handle: WorkHandle) => void;
  inject: () => void;
};

type BrowserIdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function shouldSkipDeferredFonts(connection: FontConnection | undefined): boolean {
  if (connection?.saveData) return true;
  const effectiveType = connection?.effectiveType?.toLowerCase();
  return effectiveType === "slow-2g"
    || effectiveType === "2g"
    || effectiveType === "3g";
}

export function injectDeferredFontStyles(targetDocument: Document = document): void {
  for (const url of DEFERRED_FONT_STYLESHEET_URLS) {
    const weight = url.match(/hmos-([^/]+)/)?.[1] ?? url;
    if (targetDocument.head.querySelector(
      `link[data-aifeeds-deferred-font="${weight}"]`,
    )) continue;

    const link = targetDocument.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.dataset.aifeedsDeferredFont = weight;
    targetDocument.head.appendChild(link);
  }
}

function createBrowserEnvironment(): DeferredFontEnvironment {
  const browserWindow = window as BrowserIdleWindow;
  const hasNativeIdle = typeof browserWindow.requestIdleCallback === "function";

  return {
    target: browserWindow,
    getReadyState: () => document.readyState,
    readConnection: () => (
      navigator as Navigator & { connection?: FontConnection }
    ).connection,
    setTimer: (callback, delay) => browserWindow.setTimeout(callback, delay),
    clearTimer: (handle) => browserWindow.clearTimeout(handle as number),
    scheduleIdle: (callback, timeout) => (
      hasNativeIdle
        ? browserWindow.requestIdleCallback!(callback, { timeout })
        : browserWindow.setTimeout(callback, DEFERRED_FONT_TIMER_IDLE_MS)
    ),
    cancelIdle: (handle) => {
      if (hasNativeIdle) browserWindow.cancelIdleCallback?.(handle as number);
      else browserWindow.clearTimeout(handle as number);
    },
    inject: () => injectDeferredFontStyles(document),
  };
}

/**
 * Install a one-shot font gate. Interaction wins immediately; otherwise the
 * fallback starts only after load and waits another ten seconds before idle.
 */
export function installDeferredFonts(
  environment: DeferredFontEnvironment = createBrowserEnvironment(),
): () => void {
  let triggered = false;
  let disposed = false;
  let fallbackHandle: WorkHandle | null = null;
  let idleHandle: WorkHandle | null = null;
  let listeningForLoad = false;

  const removeTriggerListeners = () => {
    environment.target.removeEventListener("pointerdown", trigger);
    environment.target.removeEventListener("keydown", trigger);
    if (listeningForLoad) {
      environment.target.removeEventListener("load", onLoad);
      listeningForLoad = false;
    }
    if (fallbackHandle !== null) {
      environment.clearTimer(fallbackHandle);
      fallbackHandle = null;
    }
  };

  const trigger = () => {
    if (triggered || disposed) return;
    triggered = true;
    removeTriggerListeners();
    if (shouldSkipDeferredFonts(environment.readConnection())) return;

    idleHandle = environment.scheduleIdle(() => {
      idleHandle = null;
      if (!disposed) environment.inject();
    }, DEFERRED_FONT_IDLE_TIMEOUT_MS);
  };

  const scheduleFallback = () => {
    if (triggered || disposed || fallbackHandle !== null) return;
    fallbackHandle = environment.setTimer(() => {
      fallbackHandle = null;
      trigger();
    }, DEFERRED_FONT_FALLBACK_MS);
  };

  const onLoad = () => {
    if (listeningForLoad) {
      environment.target.removeEventListener("load", onLoad);
      listeningForLoad = false;
    }
    scheduleFallback();
  };

  environment.target.addEventListener("pointerdown", trigger);
  environment.target.addEventListener("keydown", trigger);
  if (environment.getReadyState() === "complete") {
    scheduleFallback();
  } else {
    listeningForLoad = true;
    environment.target.addEventListener("load", onLoad);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    removeTriggerListeners();
    if (idleHandle !== null) {
      environment.cancelIdle(idleHandle);
      idleHandle = null;
    }
  };
}
