import { expect, test } from "bun:test";
import { createProfile } from "../src/profile/profile-validation.js";
import {
  awardExperience,
  experienceRequired,
} from "../src/character/offline-progression.js";
import {
  allocationError,
  allocateSkill,
  skillPointPool,
} from "../src/skills/skill-allocation-rules.js";

const minimumRoll = () => 0;

function profile(job = 100, level = 10) {
  return Object.assign(
    createProfile({ mapId: "100000000", x: 0, y: 0, facing: 1 }),
    { job, level, equipment: [] },
  );
}

function skill(book) {
  return {
    id: book * 10000,
    bookId: book,
    maxLevel: 1,
    levels: { 1: {} },
    flags: {},
    properties: {},
    prerequisites: [],
    allocationCost: { kind: "sp", amount: 1 },
  };
}

test("each earned level adds spendable AP and current-job SP without assigning primary stats", () => {
  const p = profile();
  const before = [p.str, p.dex, p.int, p.luk];
  const amount = experienceRequired(10) + experienceRequired(11);
  expect(awardExperience(p, amount, { random: minimumRoll })).toBe(2);
  expect(p.level).toBe(12);
  expect(p.remainingAp).toBe(10);
  expect(p.remainingSp).toEqual([6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect([p.str, p.dex, p.int, p.luk]).toEqual(before);
});

test("advancement cannot spend banked first-job points on second-job skills", () => {
  const p = profile(100, 29);
  awardExperience(p, experienceRequired(29), { random: minimumRoll });
  p.job = 110;
  expect(allocationError(p, skill(110), 0)).toBe("No skill points available");
  expect(allocationError(p, skill(100), 0)).toBeNull();
  awardExperience(p, experienceRequired(30), { random: minimumRoll });
  expect(allocationError(p, skill(110), 0)).toBeNull();
  allocateSkill(p, skill(110));
  expect(p.remainingSp.slice(0, 4)).toEqual([3, 2, 0, 0]);
  allocateSkill(p, skill(100));
  expect(p.remainingSp.slice(0, 4)).toEqual([2, 2, 0, 0]);
});

test("job stages retain separate pools for explorers, Cygnus, Aran and Evan", () => {
  for (const jobs of [
    [400, 420, 421, 422],
    [1100, 1110, 1111, 1112],
    [2100, 2110, 2111, 2112],
  ]) {
    expect(jobs.map(skillPointPool)).toEqual([0, 1, 2, 3]);
  }
  expect(
    [2200, 2210, 2211, 2212, 2213, 2214, 2215, 2216, 2217, 2218].map(
      skillPointPool,
    ),
  ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const job of [110, 111, 112, 2218]) {
    const p = profile(job, 150);
    awardExperience(p, experienceRequired(p.level), { random: minimumRoll });
    expect(p.remainingSp[skillPointPool(job)]).toBe(3);
    expect(p.remainingSp.reduce((sum, n) => sum + n, 0)).toBe(3);
  }
});

test("beginners use native skill entitlement and receive AP without ordinary SP", () => {
  for (const job of [0, 1000, 2000, 2001]) {
    const p = profile(job, 1);
    awardExperience(p, experienceRequired(1), { random: minimumRoll });
    expect(p.remainingAp).toBe(5);
    expect(p.remainingSp).toEqual(Array(10).fill(0));
  }
});

test("Cygnus AP bonuses use the reference pre-level boundaries", () => {
  for (const [level, points] of [
    [10, 5],
    [11, 7],
    [17, 7],
    [18, 6],
    [76, 6],
    [77, 5],
  ]) {
    const p = profile(1100, level);
    awardExperience(p, experienceRequired(level), { random: minimumRoll });
    expect(p.remainingAp).toBe(points);
  }
});

test("the final level grants points once and capped EXP grants nothing further", () => {
  const p = profile(112, 199);
  expect(
    awardExperience(p, experienceRequired(199), { random: minimumRoll }),
  ).toBe(1);
  expect(awardExperience(p, 100000, { random: minimumRoll })).toBe(0);
  expect(p.remainingAp).toBe(5);
  expect(p.remainingSp[3]).toBe(3);
});
