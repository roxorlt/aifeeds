const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function canReceiveFocus(element: HTMLElement): boolean {
  return hasRenderedBox(element)
    && !element.hasAttribute('disabled')
    && element.tabIndex >= 0;
}

function hasRenderedBox(element: HTMLElement): boolean {
  return element.isConnected
    && !element.hidden
    && element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0;
}

function focusWithoutScrolling(element: HTMLElement): void {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(canReceiveFocus);
}

function canRestoreFocus(element: Element | null): element is HTMLElement {
  return Boolean(
    element
    && element.isConnected
    && typeof (element as HTMLElement).focus === 'function',
  );
}

interface ModalFocusSession {
  container: HTMLElement;
  restoreTarget: Element | null;
  onEscape?: () => void;
}

const sessionsByDocument = new WeakMap<Document, ModalFocusSession[]>();
const claimedEscapeEvents = new WeakSet<KeyboardEvent>();

export function focusModalTrigger(element: HTMLElement | null): boolean {
  if (!canRestoreFocus(element)) return false;
  focusWithoutScrolling(element);
  return true;
}

interface ModalFocusOptions {
  onEscape?: () => void;
}

/**
 * Starts one focus session scoped to a modal panel.
 *
 * The listener lives on the panel rather than document so a nested/portal
 * dialog can own focus without fighting the parent dialog's trap.
 */
export function activateModalFocus(
  container: HTMLElement,
  options: ModalFocusOptions = {},
): () => void {
  const ownerDocument = container.ownerDocument;
  if (!hasRenderedBox(container)) return () => {};

  const sessions = sessionsByDocument.get(ownerDocument) ?? [];
  if (!sessionsByDocument.has(ownerDocument)) {
    sessionsByDocument.set(ownerDocument, sessions);
  }
  const session: ModalFocusSession = {
    container,
    restoreTarget: ownerDocument.activeElement,
    onEscape: options.onEscape,
  };
  sessions.push(session);

  const markedInitial = container.querySelector<HTMLElement>('[data-modal-initial-focus]');
  const initial = markedInitial && canReceiveFocus(markedInitial)
    ? markedInitial
    : (focusableElements(container)[0] ?? container);

  focusWithoutScrolling(initial);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (
        claimedEscapeEvents.has(event)
        || sessions.at(-1) !== session
        || !session.onEscape
      ) return;
      claimedEscapeEvents.add(event);
      event.preventDefault();
      event.stopPropagation();
      session.onEscape();
      return;
    }
    if (sessions.at(-1) !== session) return;
    if (event.key !== 'Tab') return;
    const elements = focusableElements(container);
    if (elements.length === 0) {
      event.preventDefault();
      focusWithoutScrolling(container);
      return;
    }

    const first = elements[0];
    const last = elements[elements.length - 1];
    const current = ownerDocument.activeElement;
    if (event.shiftKey && (current === first || !container.contains(current))) {
      event.preventDefault();
      focusWithoutScrolling(last);
    } else if (!event.shiftKey && (current === last || !container.contains(current))) {
      event.preventDefault();
      focusWithoutScrolling(first);
    }
  };

  container.addEventListener('keydown', onKeyDown);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    container.removeEventListener('keydown', onKeyDown);
    const sessionIndex = sessions.indexOf(session);
    if (sessionIndex < 0) return;

    const wasTopmost = sessionIndex === sessions.length - 1;
    const coveringSession = sessions[sessionIndex + 1];
    sessions.splice(sessionIndex, 1);

    // If a parent unmounts before its nested modal, keep focus in the topmost
    // modal now and pass the parent's original trigger down for final restore.
    if (
      coveringSession
      && coveringSession.restoreTarget
      && container.contains(coveringSession.restoreTarget)
    ) {
      coveringSession.restoreTarget = session.restoreTarget;
    }

    if (sessions.length === 0) sessionsByDocument.delete(ownerDocument);
    if (wasTopmost && canRestoreFocus(session.restoreTarget)) {
      focusWithoutScrolling(session.restoreTarget);
    }
  };
}
