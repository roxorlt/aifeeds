import assert from "node:assert/strict";
import test from "node:test";

import { useToastStore } from "./toast.ts";

test("dismiss keeps a toast mounted during its exit phase", async () => {
  useToastStore.setState({ items: [] });
  useToastStore.getState().push("info", "leaving", 0);
  const id = useToastStore.getState().items[0].id;

  useToastStore.getState().dismiss(id);
  assert.equal(useToastStore.getState().items[0].leaving, true);

  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(useToastStore.getState().items.length, 0);
});
