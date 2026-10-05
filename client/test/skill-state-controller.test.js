import { expect, test } from "bun:test";
import { SkillStateController } from "../src/skills/skill-state-controller.js";
import {
  TemporaryStats,
  temporaryState,
  configureTemporaryState,
  MAX_TEMPORARY_STATS,
} from "../src/skills/temporary-stats.js";
import {
  createCharacterStats,
  projectCharacterStats,
} from "../src/character/character-stats.js";
import {
  awardExperience,
  learnedGrowth,
} from "../src/character/offline-progression.js";

function fixture() {
  const profile = {
    job: 400,
    level: 30,
    str: 10,
    dex: 10,
    int: 10,
    luk: 10,
    hp: 100,
    mp: 100,
    baseMaxHP: 100,
    baseMaxMP: 100,
    maxHP: 100,
    maxMP: 100,
    equipment: [],
    inventory: [],
    skills: {},
    exp: 0,
  };
  const system = {
    store: { profile, markDirty() {} },
    catalog: {},
    fullCatalog: { ui: { items: {} } },
    effects: new TemporaryStats(),
    states: new Map(),
    hooks: {},
    wallTime: 1000,
    derived() {
      return this.effects.derived;
    },
    recompute() {
      this.effects.recompute();
      this.stateController.syncVitals();
    },
    info(id) {
      return this.catalog[id]?.levels[1];
    },
    level(id) {
      return this.store.profile.skills[id]?.level ?? 0;
    },
    onDeath() {
      this.effects.clear();
      this.stateController.onDeath();
    },
  };
  system.stateController = new SkillStateController(system);
  return system;
}
function apply(system, id, info) {
  const skill = { id, levels: { 1: info }, properties: {} };
  system.catalog[id] = skill;
  system.store.profile.skills[id] = { level: 1, expiresAt: null };
  if (!system.states.has(id)) {
    system.states.set(id, temporaryState("skill", id));
  }
  system.stateController.configure(skill, 1, info);
}

test("Hyper Body recast cannot compound maxima or discard temporary-cap HP", () => {
  const system = fixture();
  apply(system, 1301007, { x: 60, y: 60, time: 100 });
  system.store.profile.hp = 150;
  apply(system, 1301007, { x: 60, y: 60, time: 100 });
  expect(system.store.profile.maxHP).toBe(160);
  expect(system.store.profile.hp).toBe(150);
  system.stateController.cancel(1301007);
  expect(system.store.profile.maxHP).toBe(100);
  expect(system.store.profile.hp).toBe(100);
});

test("Dark Sight speed penalty survives Haste overlap and source cancellation restores movement", () => {
  const system = fixture();
  apply(system, 4101004, { speed: 40, jump: 20, time: 100 });
  apply(system, 4001003, { speed: -30, x: 1, time: 10 });
  const hooks = { items: {}, skillLevel: () => 0, skillInfo: () => null };
  const stats = createCharacterStats();
  projectCharacterStats(system.store.profile, hooks, stats, system.derived());
  expect(stats.speed).toBe(110);
  system.stateController.cancelFamily("dark-sight");
  projectCharacterStats(system.store.profile, hooks, stats, system.derived());
  expect(stats.speed).toBe(140);
  expect(system.derived().darkSight).toBe(0);
});

test("Dragon Blood drains at4000ms, includes duration boundary, and can kill", () => {
  const system = fixture();
  apply(system, 1311008, { time: 8, pad: 1, x: 48 });
  system.stateController.advanceBlood(3999);
  system.effects.find(1311008).remaining -= 3999;
  expect(system.store.profile.hp).toBe(100);
  system.stateController.advanceBlood(1);
  system.effects.find(1311008).remaining -= 1;
  expect(system.store.profile.hp).toBe(52);
  system.store.profile.hp = 40;
  system.stateController.advanceBlood(4000);
  expect(system.store.profile.hp).toBe(0);
  expect(system.effects.count).toBe(0);
});

test("MP growth uses learned x at level-up and excludes expired grants", () => {
  const system = fixture();
  const profile = system.store.profile;
  profile.job = 200;
  profile.level = 1;
  profile.remainingAp = 0;
  profile.remainingSp = Array(10).fill(0);
  profile.skills[2000001] = { level: 1, expiresAt: 2000 };
  const catalog = { 2000001: { levels: { 1: { x: 2, y: 1 } } } };
  const growth = { hp: 0, mp: 0 };
  learnedGrowth(profile, catalog, 1000, growth);
  // Magician minimum roll 22, learned x2 and INT10/20=0 (Cosmic Character.levelUp).
  awardExperience(profile, 15, { growth, items: {}, random: () => 0 });
  expect(profile.baseMaxMP).toBe(124);
  learnedGrowth(profile, catalog, 2000, growth);
  awardExperience(profile, 34, { growth, items: {}, random: () => 0 });
  expect(profile.baseMaxMP).toBe(146);
});

test("Beholder schedules stop at summon expiry and Hex starts at its actual tick", () => {
  const system = fixture();
  system.store.profile.hp = 50;
  system.worldController = {
    active: () => true,
    remainingMs: () => 5000,
    beholderEffect() {},
  };
  const aura = { id: 1320008, properties: {}, levels: { 1: { x: 4, hp: 40 } } };
  const hex = {
    id: 1320009,
    properties: {},
    levels: { 1: { x: 4, time: 20, pdd: 20 } },
  };
  system.catalog[1320008] = aura;
  system.catalog[1320009] = hex;
  system.store.profile.skills[1320008] = { level: 1, expiresAt: null };
  system.store.profile.skills[1320009] = { level: 1, expiresAt: null };
  system.stateController.advanceBeholder(10000);
  expect(system.store.profile.hp).toBe(90);
  const source = system.effects.find(1320009);
  source.remaining -= 10000;
  expect(source.remaining).toBe(14000);
  expect(system.derived().pdd).toBe(20);
});

test("Stored Brawler growth ranks cannot enhance Gunslinger level-up", () => {
  const system = fixture();
  const profile = system.store.profile;
  const catalog = { 5100000: { levels: { 1: { x: 3, y: 2 } } } };
  profile.skills[5100000] = { level: 1, expiresAt: null };
  const growth = { hp: 0, mp: 0 };
  profile.job = 510;
  learnedGrowth(profile, catalog, 1000, growth);
  expect(growth.hp).toBe(3);
  profile.job = 520;
  learnedGrowth(profile, catalog, 1000, growth);
  expect(growth.hp).toBe(0);
});

function prepareHex(system) {
  const skill = {
    id: 1320009,
    properties: {},
    levels: { 1: { x: 4, time: 20, pdd: 20 } },
  };
  system.catalog[skill.id] = skill;
  system.store.profile.skills[skill.id] = { level: 1, expiresAt: null };
  system.worldController = { beholderEffect() {} };
  apply(system, 1321007, { time: 30 });
  system.stateController.syncBeholderReservation();
  return skill;
}

function fillItems(system, count) {
  for (let index = 0; index < count; index++) {
    const state = temporaryState("item", 2000000 + index);
    configureTemporaryState(state, { pad: 1 }, 60000);
    system.effects.start(state);
  }
}

test("Beholder reserves its future Hex slot without a fake buff and keeps it between Hex publications", () => {
  const system = fixture();
  const skill = prepareHex(system);
  expect(system.effects.find(skill.id)).toBeNull();
  expect(system.effects.visibleCount).toBe(1);
  fillItems(system, MAX_TEMPORARY_STATS - 2);
  expect(system.effects.canStart(-2020000)).toBe(false);
  system.stateController.beholderTick(skill.id, 1, skill.levels[1], 1);
  expect(system.derived().pdd).toBe(20);
  expect(system.effects.count).toBe(MAX_TEMPORARY_STATS);
  system.stateController.cancel(skill.id);
  expect(system.derived().pdd).toBe(0);
  expect(system.effects.canStart(-2020000)).toBe(false);
  system.stateController.beholderTick(skill.id, 1, skill.levels[1], 1);
  expect(system.derived().pdd).toBe(20);
  system.stateController.cancel(skill.id);
  system.stateController.cancel(1321007);
  system.effects.releaseOwner(1321007);
  expect(system.effects.canStart(-2020000, -2020001)).toBe(true);
});

test("Reserved Hex can publish during an admitted item transaction without stealing the item's slot", () => {
  const system = fixture();
  const skill = prepareHex(system);
  fillItems(system, MAX_TEMPORARY_STATS - 3);
  const item = temporaryState("item", 2020000);
  configureTemporaryState(item, { acc: 10 }, 60000);
  const transaction = system.effects.reserve(item);
  expect(system.effects.canStart(-2020001)).toBe(false);
  system.stateController.beholderTick(skill.id, 1, skill.levels[1], 1);
  expect(system.derived().pdd).toBe(20);
  system.effects.publish(transaction);
  expect(system.derived().acc).toBe(10);
  expect(system.effects.count).toBe(MAX_TEMPORARY_STATS);
  expect(system.effects.canStart(-2020001)).toBe(false);
});
