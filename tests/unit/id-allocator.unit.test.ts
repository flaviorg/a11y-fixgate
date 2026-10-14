import test from "node:test";
import assert from "node:assert/strict";
import { createIdAllocator } from "../../src/domain/fix/id-allocator.ts";

test("[FIX-10] allocate returns the base when it is free in the file, the DOM and the reservations, else the smallest base-<n> from 2; reserve makes later calls skip it; has() reports reservations only", () => {
  const ids = createIdAllocator(["main", "qty", "field-2"], ["email", "main", "qty"]);
  assert.equal(ids.allocate("name"), "name");
  // The storefront case: the DOM already has the injected #email.
  assert.equal(ids.allocate("email"), "email-2");
  // allocate does not reserve: asking again gives the same answer.
  assert.equal(ids.allocate("email"), "email-2");
  ids.reserve("email-2");
  assert.equal(ids.allocate("email"), "email-3");
  // A file id is taken as well.
  assert.equal(ids.allocate("qty"), "qty-2");
  assert.equal(ids.allocate("field"), "field");
  ids.reserve("field");
  assert.equal(ids.allocate("field"), "field-3");
  // has() is "reserved in this run", never the file or the DOM (P-14).
  assert.equal(ids.has("email-2"), true);
  assert.equal(ids.has("field"), true);
  assert.equal(ids.has("main"), false);
  assert.equal(ids.has("email"), false);
  assert.equal(ids.has("name"), false);
});

test("[FIX-10] the allocator accepts any iterables and copies them", () => {
  const file = new Set(["a"]);
  const ids = createIdAllocator(file, ["a-2"][Symbol.iterator]());
  file.add("b");
  assert.equal(ids.allocate("a"), "a-3");
  assert.equal(ids.allocate("b"), "b");
});
