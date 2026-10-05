import { expect, test } from "bun:test";
import { metadataTree } from "../tools/ui-item-data.js";

/** Minimal WzNode tree: name → value (scalar) or nested object (built iteratively). */
function node(name, spec) {
  const root = { type: "Property", name, parent: null, children: {} };
  const queue = [[root, spec]];
  for (let index = 0; index < queue.length; index++) {
    const [entry, value] = queue[index];
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const next = {
          type: "Property",
          name: key,
          parent: entry,
          children: {},
        };
        entry.children[key] = next;
        queue.push([next, child]);
      }
    } else {
      entry.type = typeof value === "string" ? "String" : "Int";
      entry.value = value;
    }
  }
  return root;
}

test("numeric String nodes directly under item info become integers", () => {
  // Character.wz Coat/01040034 stores incLUK as String "1"; 1082192 stores reqLevel "35".
  const root = node("01040034.img", {
    info: {
      incPDD: 14,
      incLUK: "1",
      reqLevel: "35",
      price: "15000",
      islot: "Ma",
      effect: { left: "-10" },
    },
  });
  const { info } = metadataTree(root);
  expect(info.incLUK).toBe(1);
  expect(info.reqLevel).toBe(35);
  expect(info.price).toBe(15000);
  expect(info.incPDD).toBe(14);
  expect(info.islot).toBe("Ma"); // text stays text
  expect(info.effect.left).toBe("-10"); // only direct info children are gameplay integers
});

test("non-info numeric strings keep their original type", () => {
  const root = node("5000002.img", { chat: { target: "0" } });
  expect(metadataTree(root).chat.target).toBe("0");
});
