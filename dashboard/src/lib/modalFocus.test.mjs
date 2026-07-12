import test from "node:test";
import assert from "node:assert/strict";
import * as modalFocus from "./modalFocus.ts";

const { activateModalFocus } = modalFocus;

function createElement(name, ownerDocument) {
  return {
    name,
    ownerDocument,
    hidden: false,
    tabIndex: 0,
    isConnected: true,
    focus(options) {
      this.focusOptions.push(options);
      ownerDocument.activeElement = this;
    },
    hasAttribute() {
      return false;
    },
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{}];
    },
    focusOptions: [],
  };
}

function createKeyboardEvent(key, { shiftKey = false } = {}) {
  return {
    key,
    shiftKey,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}

function createFixture({
  focusableCount = 3,
  ownerDocument: providedDocument,
  trigger: providedTrigger,
} = {}) {
  const ownerDocument = providedDocument ?? { activeElement: null };
  const trigger = providedTrigger ?? createElement("trigger", ownerDocument);
  const focusables = Array.from(
    { length: focusableCount },
    (_, index) => createElement(`focusable-${index}`, ownerDocument),
  );
  const listeners = new Map();
  const container = {
    ...createElement("container", ownerDocument),
    querySelector(selector) {
      return selector === "[data-modal-initial-focus]" ? (focusables[0] ?? null) : null;
    },
    querySelectorAll() {
      return focusables;
    },
    contains(element) {
      return element === this || focusables.includes(element);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const dispatchKey = (event) => listeners.get("keydown")?.(event);
  const dispatchTab = ({ shiftKey = false } = {}) => {
    const event = createKeyboardEvent("Tab", { shiftKey });
    dispatchKey(event);
    return event.defaultPrevented;
  };
  trigger.focus();
  return {
    ownerDocument,
    trigger,
    focusables,
    container,
    listeners,
    dispatchKey,
    dispatchTab,
  };
}

test("modal focus starts at its explicit target, wraps Tab both ways, and restores its trigger", () => {
  const fixture = createFixture();
  const [first, , last] = fixture.focusables;

  const deactivate = activateModalFocus(fixture.container);
  assert.equal(fixture.ownerDocument.activeElement, first);

  last.focus();
  assert.equal(fixture.dispatchTab(), true);
  assert.equal(fixture.ownerDocument.activeElement, first);

  first.focus();
  assert.equal(fixture.dispatchTab({ shiftKey: true }), true);
  assert.equal(fixture.ownerDocument.activeElement, last);

  deactivate();
  assert.equal(fixture.ownerDocument.activeElement, fixture.trigger);
  assert.equal(fixture.listeners.has("keydown"), false);
});

test("modal focus keeps Tab on the panel when it has no tabbable descendants", () => {
  const fixture = createFixture({ focusableCount: 0 });

  const deactivate = activateModalFocus(fixture.container);
  assert.equal(fixture.ownerDocument.activeElement, fixture.container);
  assert.equal(fixture.dispatchTab(), true);
  assert.equal(fixture.ownerDocument.activeElement, fixture.container);

  deactivate();
});

test("modal focus does not restore a trigger that left the document", () => {
  const fixture = createFixture();
  const deactivate = activateModalFocus(fixture.container);
  fixture.trigger.isConnected = false;

  deactivate();

  assert.notEqual(fixture.ownerDocument.activeElement, fixture.trigger);
});

test("modal focus skips responsive controls that have no rendered layout box", () => {
  const fixture = createFixture();
  fixture.focusables[0].getClientRects = () => [];

  const deactivate = activateModalFocus(fixture.container);

  assert.equal(fixture.ownerDocument.activeElement, fixture.focusables[1]);
  deactivate();
});

test("modal focus ignores a responsive panel that has no rendered layout box", () => {
  const fixture = createFixture();
  fixture.container.getClientRects = () => [];

  const deactivate = activateModalFocus(fixture.container);

  assert.equal(fixture.ownerDocument.activeElement, fixture.trigger);
  assert.equal(fixture.listeners.has("keydown"), false);
  deactivate();
});

test("only the topmost nested modal traps focus and each close restores its trigger", () => {
  const ownerDocument = { activeElement: null };
  const outsideTrigger = createElement("outside-trigger", ownerDocument);
  const parent = createFixture({ ownerDocument, trigger: outsideTrigger });
  const deactivateParent = activateModalFocus(parent.container);
  const childTrigger = parent.focusables[1];
  const child = createFixture({ ownerDocument, trigger: childTrigger });
  const deactivateChild = activateModalFocus(child.container);

  assert.equal(ownerDocument.activeElement, child.focusables[0]);
  assert.equal(parent.dispatchTab(), false);
  assert.equal(ownerDocument.activeElement, child.focusables[0]);

  child.focusables.at(-1).focus();
  assert.equal(child.dispatchTab(), true);
  assert.equal(ownerDocument.activeElement, child.focusables[0]);

  deactivateChild();
  assert.equal(ownerDocument.activeElement, childTrigger);
  deactivateParent();
  assert.equal(ownerDocument.activeElement, outsideTrigger);
});

test("unmounting a covered parent defers focus restoration to the topmost modal", () => {
  const ownerDocument = { activeElement: null };
  const outsideTrigger = createElement("outside-trigger", ownerDocument);
  const parent = createFixture({ ownerDocument, trigger: outsideTrigger });
  const deactivateParent = activateModalFocus(parent.container);
  const childTrigger = parent.focusables[1];
  const child = createFixture({ ownerDocument, trigger: childTrigger });
  const deactivateChild = activateModalFocus(child.container);

  deactivateParent();
  assert.equal(ownerDocument.activeElement, child.focusables[0]);
  childTrigger.isConnected = false;

  deactivateChild();
  assert.equal(ownerDocument.activeElement, outsideTrigger);
});

test("one Escape event belongs only to the topmost session even when it closes synchronously", () => {
  const ownerDocument = { activeElement: null };
  const outsideTrigger = createElement("outside-trigger", ownerDocument);
  const parent = createFixture({ ownerDocument, trigger: outsideTrigger });
  let parentCloseCount = 0;
  const deactivateParent = activateModalFocus(parent.container, {
    onEscape: () => { parentCloseCount += 1; },
  });
  const childTrigger = parent.focusables[1];
  const child = createFixture({ ownerDocument, trigger: childTrigger });
  let childCloseCount = 0;
  let deactivateChild = () => {};
  deactivateChild = activateModalFocus(child.container, {
    onEscape: () => {
      childCloseCount += 1;
      deactivateChild();
    },
  });
  const sharedEvent = createKeyboardEvent("Escape");

  child.dispatchKey(sharedEvent);
  // Exercise the same object against the now-uncovered parent too. Event
  // ownership must survive synchronous child cleanup.
  parent.dispatchKey(sharedEvent);

  assert.equal(childCloseCount, 1);
  assert.equal(parentCloseCount, 0);
  assert.equal(sharedEvent.defaultPrevented, true);
  assert.equal(sharedEvent.propagationStopped, true);

  const parentEvent = createKeyboardEvent("Escape");
  parent.dispatchKey(parentEvent);
  assert.equal(parentCloseCount, 1);
  assert.equal(parentEvent.defaultPrevented, true);
  assert.equal(parentEvent.propagationStopped, true);
  deactivateParent();
});

test("a persistent fallback trigger can become the modal restore target before a menu item unmounts", () => {
  assert.equal(typeof modalFocus.focusModalTrigger, "function");
  const ownerDocument = { activeElement: null };
  const transientMenuItem = createElement("transient-menu-item", ownerDocument);
  const persistentTrigger = createElement("persistent-settings-trigger", ownerDocument);
  transientMenuItem.focus();

  modalFocus.focusModalTrigger(persistentTrigger);
  assert.equal(ownerDocument.activeElement, persistentTrigger);
  assert.deepEqual(persistentTrigger.focusOptions.at(-1), { preventScroll: true });

  const modal = createFixture({ ownerDocument, trigger: persistentTrigger });
  const deactivate = activateModalFocus(modal.container);
  transientMenuItem.isConnected = false;
  deactivate();

  assert.equal(ownerDocument.activeElement, persistentTrigger);
});

for (const componentName of ["LogoutConfirm", "DeleteAccountConfirm"]) {
  test(`${componentName} consumes Escape but defers dismissal while confirmation is in flight`, () => {
    const fixture = createFixture();
    const dismissAllowedRef = { current: true };
    let closeCount = 0;
    const deactivate = activateModalFocus(fixture.container, {
      onEscape: () => {
        if (dismissAllowedRef.current) closeCount += 1;
      },
    });

    // The confirm handler closes the gate synchronously before its first await.
    dismissAllowedRef.current = false;
    const loadingEscape = createKeyboardEvent("Escape");
    fixture.dispatchKey(loadingEscape);
    assert.equal(loadingEscape.defaultPrevented, true);
    assert.equal(loadingEscape.propagationStopped, true);
    assert.equal(closeCount, 0);

    // finally reopens the same ref-backed gate without replacing the session.
    dismissAllowedRef.current = true;
    const settledEscape = createKeyboardEvent("Escape");
    fixture.dispatchKey(settledEscape);
    assert.equal(settledEscape.defaultPrevented, true);
    assert.equal(settledEscape.propagationStopped, true);
    assert.equal(closeCount, 1);
    deactivate();
  });
}
