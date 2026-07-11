import test from "node:test";
import assert from "node:assert/strict";
import { activateModalFocus } from "./modalFocus.ts";

function createElement(name, ownerDocument) {
  return {
    name,
    ownerDocument,
    hidden: false,
    tabIndex: 0,
    isConnected: true,
    focus() {
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
  };
}

function createFixture({ focusableCount = 3 } = {}) {
  const ownerDocument = { activeElement: null };
  const trigger = createElement("trigger", ownerDocument);
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
  const dispatchTab = ({ shiftKey = false } = {}) => {
    let prevented = false;
    listeners.get("keydown")?.({
      key: "Tab",
      shiftKey,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  trigger.focus();
  return { ownerDocument, trigger, focusables, container, listeners, dispatchTab };
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
