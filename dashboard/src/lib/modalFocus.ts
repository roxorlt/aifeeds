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
  return !element.hidden
    && !element.hasAttribute('disabled')
    && element.getAttribute('aria-hidden') !== 'true'
    && element.tabIndex >= 0
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

/**
 * Starts one focus session scoped to a modal panel.
 *
 * The listener lives on the panel rather than document so a nested/portal
 * dialog can own focus without fighting the parent dialog's trap.
 */
export function activateModalFocus(container: HTMLElement): () => void {
  const ownerDocument = container.ownerDocument;
  const trigger = ownerDocument.activeElement;
  const markedInitial = container.querySelector<HTMLElement>('[data-modal-initial-focus]');
  const initial = markedInitial && canReceiveFocus(markedInitial)
    ? markedInitial
    : (focusableElements(container)[0] ?? container);

  focusWithoutScrolling(initial);

  const onKeyDown = (event: KeyboardEvent) => {
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
    if (canRestoreFocus(trigger)) focusWithoutScrolling(trigger);
  };
}
