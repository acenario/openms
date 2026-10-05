import { expect, test } from "bun:test";
import { createProfile } from "../src/profile/profile-validation.js";
import {
  awardExperience,
  expectedBaseVitals,
  experienceRequired,
  learnedGrowth,
  NEXT_LEVEL_EXP,
} from "../src/character/offline-progression.js";
import { transaction } from "../src/quests/quest-rules.js";

const MIN = () => 0;
const MAX = () => 0.999999;

function profile(job, level, int = 4) {
  return Object.assign(
    createProfile({ mapId: "100000000", x: 0, y: 0, facing: 1 }),
    { job, level, int, equipment: [], baseMaxHP: 1000, baseMaxMP: 1000 },
  );
}

/** Gain of exactly one level-up from `level` with the given roll source. */
function gain(job, level, random, { int = 4, growth } = {}) {
  const p = profile(job, level, int);
  expect(
    awardExperience(p, experienceRequired(level), { growth, random }),
  ).toBe(1);
  return [p.baseMaxHP - 1000, p.baseMaxMP - 1000];
}

test("EXP to next level is the original client NEXTLEVEL table", () => {
  expect(NEXT_LEVEL_EXP).toHaveLength(199);
  expect(experienceRequired(1)).toBe(15);
  expect(experienceRequired(8)).toBe(840);
  expect(experienceRequired(29)).toBe(55816);
  expect(experienceRequired(69)).toBe(1564600);
  expect(experienceRequired(199)).toBe(1608855764);
  expect(experienceRequired(200)).toBe(0);
});

test("job-family level-up gains span the Cosmic Character.levelUp ranges", () => {
  // [job, HP min..max, MP min..max] at INT4 (INT bonus 0).
  for (const [job, hp, mp] of [
    [0, [12, 16], [10, 12]],
    [100, [24, 28], [4, 6]],
    [200, [10, 14], [22, 24]],
    [300, [20, 24], [14, 16]],
    [412, [20, 24], [14, 16]],
    [510, [22, 28], [18, 23]],
  ]) {
    expect(gain(job, 10, MIN)).toEqual([hp[0], mp[0]]);
    expect(gain(job, 10, MAX)).toEqual([hp[1], mp[1]]);
  }
});

test("INT and learned Improved MaxMP Increase add to the rolled MP", () => {
  // Magician style divides total INT by 20, other jobs by 10.
  expect(gain(200, 30, MIN, { int: 100 })).toEqual([10, 22 + 5]);
  expect(gain(300, 30, MIN, { int: 100 })).toEqual([20, 14 + 10]);
  const p = profile(200, 30);
  p.skills[2000001] = { level: 10, expiresAt: null };
  const growth = learnedGrowth(
    p,
    { 2000001: { levels: { 10: { x: 20 } } } },
    0,
    { hp: 0, mp: 0 },
  );
  expect(gain(200, 30, MIN, { growth })).toEqual([10, 42]);
});

test("a level-up without an authority random source fails closed", () => {
  const p = profile(200, 1);
  expect(() => awardExperience(p, 15)).toThrow("random source");
});

test("quest EXP reward levels through the same original rules", () => {
  const p = profile(200, 8);
  const record = {
    id: 1,
    stages: [{ act: { exp: 840, money: 0, pop: 0, items: [], quests: [] } }],
  };
  const result = transaction(p, record, 0, {
    growth: { hp: 0, mp: 0 },
    items: {},
    random: MIN,
    now: 0,
  });
  expect(result.levels).toBe(1);
  expect([p.level, p.exp, p.baseMaxHP, p.baseMaxMP]).toEqual([
    9, 0, 1010, 1022,
  ]);
});

test("expected base vitals use truncated range midpoints and advancement bonuses", () => {
  // Beginner 1→9: eight levels of 14 HP / 11 MP.
  expect(expectedBaseVitals({ job: 0, level: 9 })).toEqual({
    baseMaxHP: 50 + 8 * 14,
    baseMaxMP: 30 + 8 * 11,
  });
  // Magician at 8 (+125 MP), then one Magician level (12 HP / 23 MP).
  expect(
    expectedBaseVitals({ job: 200, level: 9, advancements: { 1: 8 } }),
  ).toEqual({
    baseMaxHP: 50 + 7 * 14 + 12,
    baseMaxMP: 30 + 7 * 11 + 125 + 23,
  });
  // Bowman at 10: +125 HP / +37 MP; Warrior at 10: +225 HP.
  expect(expectedBaseVitals({ job: 300, level: 10 })).toEqual({
    baseMaxHP: 50 + 9 * 14 + 125,
    baseMaxMP: 30 + 9 * 11 + 37,
  });
  expect(expectedBaseVitals({ job: 100, level: 10 })).toEqual({
    baseMaxHP: 50 + 9 * 14 + 225,
    baseMaxMP: 30 + 9 * 11,
  });
});

test("expected base vitals count learned growth ranks, INT and AP", () => {
  const catalog = { 1000001: { levels: { 5: { x: 10 }, 10: { x: 20 } } } };
  const base = expectedBaseVitals({ job: 100, level: 13 });
  const learned = expectedBaseVitals(
    {
      job: 100,
      level: 13,
      skills: [
        { id: 1000001, rank: 10, level: 12 },
        { id: 1000001, rank: 5, level: 11 },
      ],
    },
    catalog,
  );
  // Levels 11→12 at rank5, 12→13 at rank10.
  expect(learned.baseMaxHP - base.baseMaxHP).toBe(10 + 20);
  // Arch Mage (standard 8/30/70/120): INT100 adds 10 per Beginner and 5 per Magician level.
  const low = expectedBaseVitals({ job: 212, level: 125 });
  const high = expectedBaseVitals({ job: 212, level: 125, int: 100 });
  expect(high.baseMaxMP - low.baseMaxMP).toBe(7 * 10 + (125 - 8) * 5);
  // Warrior AP: 18..22 HP → 20 per point.
  const ap = expectedBaseVitals({ job: 100, level: 13, ap: { hp: 2, mp: 0 } });
  expect(ap.baseMaxHP - base.baseMaxHP).toBe(40);
  expect(() =>
    expectedBaseVitals({ job: 110, level: 20, advancements: { 2: 25 } }),
  ).toThrow("tier 2");
});
