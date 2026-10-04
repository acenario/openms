import { expect, test } from "bun:test";
import { fixture } from "./party-fixture.js";
import { advanceCombat } from "../src/field-combat.js";

/** One real field quantum: neutral disconnected physics, then shared combat/recovery. */
function tick(world, field, nudge) {
  field.tick++;
  for (const actor of field.characters.values()) world.moveActor(actor);
  if (nudge) nudge.simulation.x += field.tick % 2 ? 1 : -1;
  advanceCombat(world, field);
}

/** A beginner on safe ground at full HP/MP, so both native timers start at zero. */
async function grounded(mapId) {
  const { world, actors } = await fixture(0, [], mapId);
  const [actor] = actors;
  const field = actor.field;
  const spawn = field.manifest.physics.portals.find((p) => p.name === "sp");
  actor.connection = null;
  actor.simulation.x = spawn.x;
  actor.simulation.y = spawn.y - 20;
  actor.profile.hp = actor.profile.maxHP;
  for (let count = 0; actor.simulation.action !== "stand1"; count++) {
    if (count > 200) throw new Error("Fixture actor did not land");
    tick(world, field);
  }
  tick(world, field);
  return { world, field, actor, profile: actor.profile };
}

function advance(probe, ticks, nudge) {
  for (let count = 0; count < ticks; count++) {
    tick(probe.world, probe.field, nudge);
  }
}

test("standing gains native HP 10 and MP 3 on the 10000 ms quantum and publishes", async () => {
  const probe = await grounded(100000000);
  probe.profile.hp = 100;
  probe.profile.mp = 100;
  probe.actor.runtimeDirty = false;
  advance(probe, 333);
  expect([probe.profile.hp, probe.profile.mp]).toEqual([100, 100]);
  advance(probe, 1);
  expect([probe.profile.hp, probe.profile.mp]).toEqual([110, 103]);
  expect(probe.actor.runtimeDirty).toBe(true);
});

test("moving keeps MP recovery but never HP", async () => {
  const probe = await grounded(100000000);
  probe.profile.hp = 100;
  probe.profile.mp = 100;
  advance(probe, 334, probe.actor);
  expect([probe.profile.hp, probe.profile.mp]).toEqual([100, 103]);
});

test("dead actors recover nothing and maxima cap recovery", async () => {
  const probe = await grounded(100000000);
  probe.profile.hp = probe.profile.maxHP - 4;
  probe.profile.mp = probe.profile.maxMP - 1;
  advance(probe, 334);
  expect(probe.profile.hp).toBe(probe.profile.maxHP);
  expect(probe.profile.mp).toBe(probe.profile.maxMP);
  probe.profile.hp = 0;
  probe.profile.mp = 0;
  advance(probe, 700);
  expect([probe.profile.hp, probe.profile.mp]).toEqual([0, 0]);
});

test("the server map's original info/recovery multiplies both amounts", async () => {
  const probe = await grounded(105040401);
  expect(probe.field.manifest.physics.map.recovery).toBe(2);
  probe.profile.hp = 100;
  probe.profile.mp = 100;
  advance(probe, 334);
  expect([probe.profile.hp, probe.profile.mp]).toEqual([120, 106]);
});
