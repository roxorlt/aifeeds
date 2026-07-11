export interface TurnstileCallbacks {
  onToken: (token: string) => void;
  onError?: (message: string) => void;
  onExpire?: () => void;
}

export interface TurnstileCallbackBridge {
  update: (callbacks: TurnstileCallbacks) => void;
  onToken: (token: string) => void;
  onError: (message: string) => void;
  onExpire: () => void;
}

/**
 * Cloudflare keeps the callbacks supplied during its one-time render. This
 * stable bridge lets those SDK-owned function references dispatch to the
 * latest React props without rebuilding the widget.
 */
export function createTurnstileCallbackBridge(
  initial: TurnstileCallbacks,
): TurnstileCallbackBridge {
  let current = initial;
  return {
    update(callbacks) {
      current = callbacks;
    },
    onToken(token) {
      current.onToken(token);
    },
    onError(message) {
      current.onError?.(message);
    },
    onExpire() {
      current.onExpire?.();
    },
  };
}
