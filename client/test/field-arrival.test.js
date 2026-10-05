import { expect, test } from "bun:test";
import {
  arrivalPosition,
  fieldArrival,
  nearestSavedArrival,
} from "../src/world/field-arrival.js";

const MAP = "100000000";

function spawn(id, x, y, extra = {}) {
  return { id, x, y, type: 0, targetMap: 999999999, name: "sp", ...extra };
}

function manifest(portals) {
  return { id: MAP, physics: { portals } };
}

function saved(x, y) {
  return { mapId: MAP, x, y, facing: -1 };
}

test("reload chooses nearest authored XY, including unlinked type1 rather than arbitrary saved feet", () => {
  const field = manifest([
    spawn(0, 100, 900),
    spawn(1, 150, 100),
    spawn(2, 103, 102, { type: 1, name: "gm00" }),
    spawn(3, 101, 100, { type: 2 }),
    spawn(4, 101, 100, { type: 1, targetMap: 100000001 }),
  ]);
  const location = saved(101, 100);
  expect(fieldArrival(field, null, location)).toEqual({
    x: 103,
    y: 92,
    facing: -1,
  });
  expect(location).toEqual(saved(101, 100));
});

test("distance ranks portal feet before entry offset; tied IDs ignore collection order", () => {
  const field = manifest([spawn(8, 0, 12), spawn(2, 0, 0)]);
  expect(nearestSavedArrival(field, saved(0, 4)).y).toBe(-10);
  const tie = manifest([spawn(8, -10, 0), spawn(2, 10, 0)]);
  expect(nearestSavedArrival(tie, saved(0, 0)).x).toBe(10);
  tie.physics.portals.reverse();
  expect(nearestSavedArrival(tie, saved(0, 0)).x).toBe(10);
});

test("named/numeric and explicit arrivals override reload selection without spawn eligibility filtering", () => {
  const field = manifest([
    spawn(0, 0, 0),
    spawn(7, 100, 200, { type: 2, name: "east", targetMap: 100000001 }),
  ]);
  const location = saved(1, 1);
  expect(fieldArrival(field, "east", location)).toEqual({ x: 100, y: 190 });
  expect(fieldArrival(field, 7, location)).toEqual({ x: 100, y: 190 });
  const explicit = { x: 43, y: 87 };
  expect(fieldArrival(field, "missing", location, explicit)).toBe(explicit);
  expect(
    fieldArrival(field, null, { ...location, mapId: "100000001" }),
  ).toBeNull();
  // Cosmic GenericPortal: an absent target name enters destination portal ID0.
  expect(arrivalPosition(field, "missing")).toEqual({ x: 0, y: -10 });
  expect(() => arrivalPosition(manifest([]), "missing")).toThrow();
  expect(() => arrivalPosition(field, 9)).toThrow();
  field.physics.portals.push(spawn(8, 3, 4, { name: "east" }));
  expect(() => arrivalPosition(field, "east")).toThrow();
});

test("missing or malformed spawns fail rather than restoring arbitrary coordinates", () => {
  expect(() => nearestSavedArrival(manifest([]), saved(5, 5))).toThrow();
  const field = manifest([spawn(0, 0, 0)]);
  expect(() => nearestSavedArrival(field, saved(NaN, 0))).toThrow();
  expect(() => nearestSavedArrival(field, saved(0, Infinity))).toThrow();
  field.physics.portals.push(spawn(1, NaN, 0));
  expect(() => nearestSavedArrival(field, saved(0, 0))).toThrow();
  expect(fieldArrival(manifest([]), null, saved(5, 5), { x: 8, y: 9 })).toEqual(
    {
      x: 8,
      y: 9,
    },
  );
});
