import { expect, test } from "bun:test";
import { itemView } from "../src/field-views.js";

test("equipment stats publish as numbers even when original info stores a String", () => {
  // Character.wz Coat/01040034 (Dark Nightshift) stores incLUK as String "1".
  const items = { 1040034: { info: { tuc: 7, incPDD: 14, incLUK: "1" } } };
  const item = {
    id: 1040034,
    uid: "c411c2db-fde5-4a2a-a140-32b002444b73",
    count: 1,
    owner: "",
    flags: 0,
  };
  const view = itemView(item, 1, false, items);
  const luk = view.equipment.stats.find((stat) => stat.key === "luk");
  expect(luk.value).toBe(1);
  expect(
    view.equipment.stats.every((stat) => typeof stat.value === "number"),
  ).toBe(true);
  expect(view.equipment.upgradesRemaining).toBe(7);
});
