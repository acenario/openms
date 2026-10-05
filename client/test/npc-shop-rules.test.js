import { expect, test } from "bun:test";
import { SHOP_LIMITS, shopBuyLimit } from "../src/npc/npc-shop-rules.js";

test("only non-rechargeable Use/Setup/Etc rows prompt for a count", () => {
  expect(shopBuyLimit(2060000)).toBe(SHOP_LIMITS.quantity);
  expect(shopBuyLimit(3010000)).toBe(SHOP_LIMITS.quantity);
  expect(shopBuyLimit(4000000)).toBe(SHOP_LIMITS.quantity);
  expect(shopBuyLimit(1302000)).toBe(1);
  expect(shopBuyLimit(2070000)).toBe(1);
  expect(shopBuyLimit(2330000)).toBe(1);
  expect(shopBuyLimit(5040000)).toBe(1);
});
