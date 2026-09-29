import { expect, test } from "bun:test";
import original from "../../docs/ghidra-physics-motion/wz-globals.json";
import { movementStreamView } from "../src/movement-stream.js";
import { OnlineWorld } from "../src/world.js";
import { prepareActorCombat } from "../src/field-combat.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import {
  TemporaryStats,
  temporaryState,
  configureTemporaryState,
} from "../../client/src/skills/temporary-stats.js";
import {
  createSimulation,
  advanceSimulation,
} from "../../client/src/physics/simulation.js";
import { attachGround } from "../../client/src/physics/geometry.js";
import { updatePlayerMovement } from "../../client/src/physics/skill-movement.js";
import {
  assignHeldInput,
  captureMotion,
  createHeldInput,
  restoreMotion,
  stepMotion,
} from "../../shared/motion.js";

// Isolating geometry; constants are independently recovered original Physics.img.
const terrain = {
  schemaVersion: 1,
  globals: original.globals,
  map: {},
  ladders: [],
  footholds: [
    {
      id: 1,
      layer: 1,
      group: 0,
      x1: -1000,
      y1: 0,
      x2: 1000,
      y2: 0,
      prev: 0,
      next: 0,
      properties: {},
    },
  ],
};

function standing() {
  const sim = createSimulation(terrain, { x: 0, y: 0 });
  attachGround(sim, sim.geometry.byId.get(1));
  return sim;
}

function fixture() {
  const profile = createProfile({ mapId: "000010000", x: 0, y: 0, facing: 1 });
  const items = Object.fromEntries(
    profile.equipment.map(({ id }) => [id, { info: {} }]),
  );
  const effects = new TemporaryStats();
  const actor = {
    id: "test",
    state: "active",
    profile,
    simulation: standing(),
    field: { epoch: "parity", tick: 0, manifest: {}, characters: new Map() },
    input: createHeldInput(),
    inputQueue: new Map(),
    lastInputTick: 0,
    inputSeq: 0,
    attackEdges: [],
    receivedAttack: false,
    temporaryStats: effects,
    skills: { effects, derived: () => effects.derived, level: () => 0 },
    skillField: {
      hasPendingIncoming: false,
      blocksMovement: false,
      combat: null,
    },
  };
  const world = new OnlineWorld({
    content: { items, catalog: { ui: { skills: {} } } },
  });
  prepareActorCombat(world, actor);
  world.moveActor(actor);
  return {
    world,
    actor,
    offline: standing(),
    input: createHeldInput(),
    items,
    effects,
  };
}

function buff(state, values) {
  const effect = temporaryState("skill", 4101004);
  configureTemporaryState(effect, values, 1000);
  state.effects.start(effect);
}

/** Exercise the real server admission/step and the offline beforePhysics path. */
function advance(state, wire) {
  const { actor, world, offline, input, items, effects } = state;
  actor.field.tick++;
  world.moveActor(actor);
  updatePlayerMovement(
    offline,
    actor.profile.equipment,
    items,
    effects.derived,
  );
  assignHeldInput(input, wire);
  advanceSimulation(offline, input, 30);
  const { x, y, vx, vy } = offline;
  world.input(actor, {
    ...wire,
    ...movementStreamView(actor),
    fieldEpoch: actor.field.epoch,
    targetTick: actor.movementStream.tick + 1,
    inputSeq: actor.field.tick,
    movementLocked: false,
    impulses: [],
    motion: { x, y, vx, vy },
  });
  world.moveActor(actor);
  for (const key of [
    "x",
    "y",
    "vx",
    "vy",
    "state",
    "action",
    "facing",
    "footholdId",
  ]) {
    expect(actor.simulation[key]).toEqual(offline[key]);
  }
  expect(actor.simulation.effectiveSettings).toEqual(offline.effectiveSettings);
}

const right = { horizontal: 1, vertical: 0, jump: false, attack: false };

test("displayed 100% runs at original 125 px/s and jumps with the offline impulse", () => {
  const state = fixture();
  for (let tick = 0; tick < 20; tick++) advance(state, right);
  expect(state.actor.stats.speed).toBe(100);
  expect(state.actor.stats.jump).toBe(100);
  expect(state.actor.simulation.vx).toBe(125);
  advance(state, { ...right, jump: true });
  expect(state.actor.simulation.y).toBeCloseTo(-16.75, 10);
  expect(state.actor.simulation.vy).toBe(-495);
  for (let tick = 0; tick < 25; tick++) advance(state, right);
  expect(state.actor.simulation.state).toBe("ground");
});

test("buff replacement, cancellation and shoe coefficients match the offline trajectory", () => {
  const state = fixture();
  state.items[1072001].info = { fs: 0.5, swim: 120 };
  buff(state, { speed: 20, jump: 10 });
  for (let tick = 0; tick < 20; tick++) advance(state, right);
  expect(state.actor.stats.speed).toBe(120);
  expect(state.actor.simulation.effectiveSettings.walkSpeed).toBe(150);
  buff(state, { speed: 80, jump: 80 });
  advance(state, { ...right, jump: true });
  expect(state.actor.simulation.effectiveSettings.walkSpeed).toBeCloseTo(
    175,
    10,
  );
  expect(state.actor.simulation.effectiveSettings.jumpSpeed).toBe(555 * 1.23);
  state.effects.remove(4101004);
  state.effects.recompute();
  advance(state, right);
  expect(state.actor.simulation.effectiveSettings.walkSpeed).toBe(125);
  state.actor.profile.equipment.find(({ slot }) => slot === -7).flags = 2;
  advance(state, right);
  expect(state.actor.simulation.worldMovement.equipmentFs).toBe(10);
});

test("forms and restricted fields retain offline coefficients in received checkpoints", () => {
  const state = fixture();
  const form = {
    id: 1000,
    speed: 160,
    jump: 120,
    swim: 90,
    fs: 0.8,
    riding: true,
  };
  state.actor.simulation.worldMovement.form = { ...form };
  state.offline.worldMovement.form = { ...form };
  buff(state, { speed: 20, jump: 10 });
  advance(state, { ...right, jump: true });
  expect(state.actor.simulation.effectiveSettings.walkSpeed).toBe(225);
  const received = standing();
  const checkpoint = captureMotion(state.actor.simulation);
  restoreMotion(received, structuredClone(checkpoint));
  const input = createHeldInput();
  assignHeldInput(input, right);
  stepMotion(received, input);
  advance(state, right);
  expect(captureMotion(received)).toEqual(
    captureMotion(state.actor.simulation),
  );
  state.actor.simulation.fieldLimit = 2;
  state.offline.fieldLimit = 2;
  advance(state, right);
  expect(state.actor.simulation.effectiveSettings.walkSpeed).toBe(125);
  expect(state.actor.simulation.effectiveSettings.jumpSpeed).toBe(555);
});
