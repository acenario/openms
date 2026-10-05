import { expect, test } from "bun:test";
import { loadContent } from "../src/content.js";

const content = await loadContent();
const catalog = content.catalog;
const DARK_MARBLE = 4031013;
// Test map → [inside instructor, test mobs] from the vendored 1072000–1072007 warps.
const TESTS = {
  108000100: [1072006, [9000200, 9000201]],
  108000200: [1072005, [9000001, 9000002]],
  108000300: [1072004, [9000100, 9000101]],
  108000400: [1072007, [9000300, 9000301]],
};
// Outside job instructors and the map their completed test warps back to.
const GATES = {
  102020300: 1072000,
  101020000: 1072001,
  106010000: 1072002,
  102040000: 1072003,
};

async function npcs(mapId) {
  const map = await content.map(String(mapId));
  return map.life.placements
    .filter((placement) => placement.kind === "npc")
    .map((placement) => Number(placement.template.slice(4)));
}

test("explorer job-test maps, inside instructors and Dark Marble drops are packaged", async () => {
  for (const [mapId, [npcId, mobs]] of Object.entries(TESTS)) {
    expect(catalog.routes.ids).toContain(mapId);
    expect(await npcs(mapId)).toContain(npcId);
    for (const mobId of mobs) {
      expect(catalog.spawns.mobs[mobId]).toContainEqual(
        expect.objectContaining({ mapId }),
      );
      expect(catalog.drops.mobs[mobId].rows).toContainEqual(
        expect.objectContaining({
          itemId: DARK_MARBLE,
          questId: 0,
          status: "supported",
        }),
      );
    }
  }
  for (const [mapId, npcId] of Object.entries(GATES)) {
    expect(await npcs(mapId)).toContain(npcId);
  }
});
