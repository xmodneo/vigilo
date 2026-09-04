import { expect, test } from "vitest";
import { shippingCostCents } from "../src/shipping-cost.js";

test("charges 500 cents below the free-shipping threshold", () => {
  expect(shippingCostCents(4_999)).toBe(500);
});

test("offers free shipping at exactly 5000 cents", () => {
  expect(shippingCostCents(5_000)).toBe(0);
});

test("offers free shipping above the threshold", () => {
  expect(shippingCostCents(5_001)).toBe(0);
});
