export type DetailLoadHandlers<T> = {
  onSuccess: (id: string, value: T) => void;
  onError: (id: string, error: unknown) => void;
};

type ActiveDetailLoad<T> = {
  id: string;
  token: symbol;
  promise: Promise<T>;
};

export type DetailLoader<T> = {
  enter: (id: string, handlers: DetailLoadHandlers<T>) => Promise<T>;
  supersede: (id: string) => void;
  leave: () => void;
  activeId: () => string | null;
};

/**
 * Owns one read-only detail request for each contiguous drawer entry.
 *
 * Optimistic card open and the following URL effect both call enter(); the
 * same active id is coalesced. Switching ids or leaving invalidates callbacks
 * from older promises without requiring fetch cancellation support.
 */
export function createDetailLoader<T>(
  load: (id: string) => Promise<T>,
): DetailLoader<T> {
  let active: ActiveDetailLoad<T> | null = null;

  const enter = (id: string, handlers: DetailLoadHandlers<T>): Promise<T> => {
    if (active?.id === id) return active.promise;

    const token = Symbol(id);
    let promise: Promise<T>;
    try {
      promise = load(id);
    } catch (error) {
      promise = Promise.reject(error);
    }
    active = { id, token, promise };

    void promise.then(
      (value) => {
        if (active?.token === token) handlers.onSuccess(id, value);
      },
      (error: unknown) => {
        if (active?.token === token) handlers.onError(id, error);
      },
    );
    return promise;
  };

  return {
    enter,
    supersede: (id: string) => {
      if (active?.id !== id) return;
      // Preserve the contiguous entry for open→URL dedupe, but invalidate the
      // callbacks captured by the older promise. A refresh-origin full detail
      // response has already become the authoritative state.
      active = { ...active, token: Symbol(id) };
    },
    leave: () => {
      active = null;
    },
    activeId: () => active?.id ?? null,
  };
}
