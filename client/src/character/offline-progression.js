import { recalculateVitals, equippedStat } from "./character-stats.js";
import { hpGrowth, mpGrowth } from "./ap-rules.js";
import { skillPointPool } from "../skills/skill-allocation-rules.js";
import { STARTING_VITALS } from "../profile/profile-validation.js";

/** Original client EXP table plus Cosmic GMSv83 level-up semantics (docs/character-gameplay-corrections.md#level-progression). */
export const PROGRESSION_POLICY = Object.freeze({
  authority: "original-client-exp-table/cosmic-server-reference",
  maxLevel: 200,
  apPerLevel: 5,
  spPerLevel: 3,
});

/** Maplestory_UNPACKED.exe NEXTLEVEL constructor 0078c8a6 stores levels1..199 into
 * 0x00bef230+4*level (0078c9f1..0078d14e); getter 0078d166 returns 0 at200. */
export const NEXT_LEVEL_EXP = Object.freeze([
  15, 34, 57, 92, 135, 372, 560, 840, 1242, 1144, 1573, 2144, 2800, 3640, 4700,
  5893, 7360, 9144, 11120, 13478, 16268, 19320, 22881, 27009, 31478, 36601,
  42446, 48722, 55816, 76560, 86784, 98208, 110932, 124432, 139372, 155865,
  173280, 192400, 213345, 235372, 259392, 285532, 312928, 342624, 374760,
  408336, 444544, 483532, 524160, 567772, 598886, 631704, 666321, 702836,
  741351, 781976, 824828, 870028, 917705, 967995, 1021040, 1076993, 1136012,
  1198265, 1263930, 1333193, 1406252, 1483314, 1564600, 1650340, 1740778,
  1836172, 1936794, 2042930, 2154882, 2272969, 2397528, 2528912, 2667496,
  2813674, 2967863, 3130501, 3302052, 3483004, 3673872, 3875200, 4087561,
  4311559, 4547832, 4797052, 5059931, 5337215, 5629694, 5938201, 6263614,
  6606860, 6968915, 7350811, 7753635, 8178534, 8626717, 9099461, 9598112,
  10124088, 10678888, 11264090, 11881362, 12532460, 13219239, 13943652,
  14707764, 15513749, 16363902, 17260644, 18206527, 19204244, 20256636,
  21366700, 22537594, 23772654, 25075395, 26449526, 27898960, 29427822,
  31040466, 32741483, 34535716, 36428272, 38424541, 40530206, 42751261,
  45094030, 47565183, 50171755, 52921167, 55821246, 58880250, 62106888,
  65510344, 69100311, 72887008, 76881216, 81094306, 85538273, 90225770,
  95170142, 100385465, 105886588, 111689173, 117809740, 124265713, 131075474,
  138258409, 145834970, 153826726, 162256430, 171148082, 180526996, 190419876,
  200854884, 211861732, 223471754, 235718006, 248635352, 262260569, 276632448,
  291791906, 307782102, 324648561, 342439302, 361204976, 380999008, 401877753,
  423900654, 447130409, 471633156, 497478652, 524740482, 553496260, 583827855,
  615821621, 649568646, 685165008, 722712050, 762316670, 804091623, 848155844,
  894634784, 943660769, 995373379, 1049919840, 1107455447, 1168144005,
  1232158296, 1299680571, 1370903066, 1446028554, 1525270918, 1608855764,
]);

/** EXP remaining in the current level; stored profile EXP is within-level, as in Cosmic. */
export function experienceRequired(level) {
  if (
    !Number.isSafeInteger(level) ||
    level < 1 ||
    level > PROGRESSION_POLICY.maxLevel
  ) {
    throw new Error("Unsupported local character level");
  }
  return level === PROGRESSION_POLICY.maxLevel ? 0 : NEXT_LEVEL_EXP[level - 1];
}

const range = (hp0, hp1, mp0, mp1) =>
  Object.freeze({
    hp: Object.freeze([hp0, hp1]),
    mp: Object.freeze([mp0, mp1]),
  });
const BEGINNER_GROWTH = range(12, 16, 10, 12);
const WARRIOR_GROWTH = range(24, 28, 4, 6);
const MAGICIAN_GROWTH = range(10, 14, 22, 24);
const ARCHER_THIEF_GROWTH = range(20, 24, 14, 16);
const GM_GROWTH = range(30000, 30000, 30000, 30000);
const PIRATE_GROWTH = range(22, 28, 18, 23);
// Cosmic adds floor(aids*0.1) to rand(4,8): always0, so the MP range is exactly4..8.
const ARAN_GROWTH = range(44, 48, 4, 8);
const NO_RANGE = range(0, 0, 0, 0);

const FAMILY_GROWTH = new Map([
  [1, WARRIOR_GROWTH],
  [11, WARRIOR_GROWTH],
  [2, MAGICIAN_GROWTH],
  [12, MAGICIAN_GROWTH],
  [3, ARCHER_THIEF_GROWTH],
  [4, ARCHER_THIEF_GROWTH],
  [13, ARCHER_THIEF_GROWTH],
  [14, ARCHER_THIEF_GROWTH],
  [9, GM_GROWTH],
  [5, PIRATE_GROWTH],
  [15, PIRATE_GROWTH],
  [21, ARAN_GROWTH],
]);

/** Cosmic Character.levelUp 6323–6358: inclusive Randomizer.rand ranges by Job.isA family. */
export function levelUpGrowthRange(job) {
  if (job === 0 || job === 1000 || job === 2000) return BEGINNER_GROWTH;
  return FAMILY_GROWTH.get(Math.trunc(job / 100)) ?? NO_RANGE;
}

/** Cosmic levelUp 6365–6371 (config.yaml:226 USE_RANDOMIZE_HPMP_GAIN=true): total INT
 * /20 for the Magician job style (getJobStyleInternal 427: families2/12/22), else /10. */
export function levelUpIntMp(job, intellect) {
  const family = Math.trunc(job / 100);
  return Math.trunc(
    intellect / (family === 2 || family === 12 || family === 22 ? 20 : 10),
  );
}

const WARRIOR_ADVANCE = range(200, 250, 0, 0);
const MAGICIAN_ADVANCE = range(0, 0, 100, 150);
const FIRST_ADVANCE = range(100, 150, 25, 50);
const WARRIOR_LATER = range(300, 350, 0, 0);
const MAGICIAN_LATER = range(0, 0, 450, 500);
const OTHER_LATER = range(300, 350, 150, 200);

/** Cosmic Character.changeJob 1193–1210 for the new job (job % 1000). */
export function jobAdvancementGrowthRange(newJob) {
  const job = newJob % 1000;
  if (job === 100) return WARRIOR_ADVANCE;
  if (job === 200) return MAGICIAN_ADVANCE;
  if (job % 100 === 0) return FIRST_ADVANCE;
  if (job > 0 && job < 200) return WARRIOR_LATER;
  if (job < 300) return MAGICIAN_LATER;
  return OTHER_LATER;
}

/** Cosmic Randomizer.rand(lbound, ubound) with an authority-owned [0,1) source. */
export function rollGrowth([minimum, maximum], random) {
  if (minimum === maximum) return minimum;
  const sample = random?.();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("Level-up random source must return a value in [0,1)");
  }
  return minimum + Math.floor(sample * (maximum - minimum + 1));
}

const NO_GROWTH = Object.freeze({ hp: 0, mp: 0 });
const HP_GROWTH = new Map([
  [1, 1000001],
  [11, 11000000],
  [51, 5100000],
  [151, 15100000],
]);
const MP_GROWTH = new Map([
  [2, 2000001],
  [12, 12000000],
]);

/** Cosmic Character level-up consumes x; AssignAPProcessor separately consumes y. */
export function learnedGrowth(profile, catalog, now, output) {
  const family = Math.trunc(profile.job / 100);
  const hpSkill =
    HP_GROWTH.get(family) ?? HP_GROWTH.get(Math.trunc(profile.job / 10));
  output.hp = growthValue(profile, catalog, hpSkill, now);
  output.mp = growthValue(profile, catalog, MP_GROWTH.get(family), now);
  return output;
}

function growthValue(profile, catalog, id, now) {
  if (id === undefined) return 0;
  const record = profile.skills[id];
  if (
    !record?.level ||
    (record.expiresAt !== null && record.expiresAt <= now)
  ) {
    return 0;
  }
  const info = catalog[id]?.levels[record.level];
  if (!Number.isSafeInteger(info?.x) || info.x < 0) {
    throw new Error("Original learned vital growth unavailable");
  }
  return info.x;
}

function validateGrowth(growth) {
  if (
    !Number.isSafeInteger(growth.hp) ||
    growth.hp < 0 ||
    !Number.isSafeInteger(growth.mp) ||
    growth.mp < 0
  ) {
    throw new Error("Invalid learned vital growth bonus");
  }
}

/** Cosmic Character.levelUp/levelUpGainSp; job-separated SP is the requested game policy. */
function awardLevelPoints(profile) {
  const previousLevel = profile.level - 1;
  const cygnus = Math.trunc(profile.job / 1000) === 1;
  const bonus =
    cygnus && previousLevel > 10 && previousLevel < 77
      ? previousLevel <= 17
        ? 2
        : 1
      : 0;
  const ap = profile.remainingAp + PROGRESSION_POLICY.apPerLevel + bonus;
  const pool = skillPointPool(profile.job);
  const sp =
    profile.remainingSp[pool] +
    (profile.job % 1000 >= 100 ? PROGRESSION_POLICY.spPerLevel : 0);
  if (!Number.isSafeInteger(ap) || !Number.isSafeInteger(sp)) {
    throw new Error("Level-up point balance exceeds the profile limit");
  }
  profile.remainingAp = ap;
  profile.remainingSp[pool] = sp;
}

/** Mutate an owned profile or transaction draft; caller persists and emits effects.
 * `random` is required whenever a level is earned (server/offline authority source). */
export function awardExperience(
  profile,
  amount,
  { growth = NO_GROWTH, items, random } = {},
) {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(profile.exp + amount)
  ) {
    throw new Error("Invalid local EXP award");
  }
  validateGrowth(growth);
  experienceRequired(profile.level);
  if (profile.level === PROGRESSION_POLICY.maxLevel) return 0;
  profile.exp += amount;
  let gained = 0,
    intellect = null;
  for (
    let count = profile.level;
    count < PROGRESSION_POLICY.maxLevel;
    count++
  ) {
    const required = experienceRequired(profile.level);
    if (profile.exp < required) break;
    // ponytail: total INT is base + equipment; temporary buffs (Maple Warrior) are not counted.
    intellect ??= profile.int + equippedStat(profile, items, "incINT");
    const rolls = levelUpGrowthRange(profile.job);
    const hp = rollGrowth(rolls.hp, random) + growth.hp;
    const mp =
      rollGrowth(rolls.mp, random) +
      growth.mp +
      levelUpIntMp(profile.job, intellect);
    profile.exp -= required;
    profile.level++;
    profile.baseMaxHP = Math.min(30000, profile.baseMaxHP + hp);
    profile.baseMaxMP = Math.min(30000, profile.baseMaxMP + mp);
    awardLevelPoints(profile);
    gained++;
  }
  if (gained) {
    recalculateVitals(profile, items);
    profile.hp = profile.maxHP;
    profile.mp = profile.maxMP;
  }
  if (profile.level === PROGRESSION_POLICY.maxLevel) profile.exp = 0;
  return gained;
}

/** Advancement tier: 0 beginner, 1 first job, 2..4 second..fourth (job % 10). */
function jobTier(job) {
  const branch = job % 1000;
  if (branch === 0) return 0;
  return branch % 100 === 0 ? 1 : 2 + (branch % 10);
}

function jobAtTier(job, tier) {
  if (tier === 0) return Math.trunc(job / 1000) * 1000;
  if (tier === 1) return Math.trunc(job / 100) * 100;
  return Math.trunc(job / 10) * 10 + tier - 2;
}

const expected = ([minimum, maximum]) => Math.trunc((minimum + maximum) / 2);

/** Standard advancement levels when the history is unknown: Magician 8, other first jobs 10. */
function standardAdvancement(job, tier) {
  if (tier === 1) return Math.trunc(job / 100) % 10 === 2 ? 8 : 10;
  return [0, 0, 30, 70, 120][tier];
}

function advancementLevels(job, level, advancements) {
  const at = [1];
  for (let tier = 1; tier <= jobTier(job); tier++) {
    at[tier] = advancements[tier] ?? standardAdvancement(job, tier);
    if (
      !Number.isSafeInteger(at[tier]) ||
      at[tier] < at[tier - 1] ||
      at[tier] > level
    ) {
      throw new Error(`Invalid job advancement level for tier ${tier}`);
    }
  }
  return at;
}

/** Growth-skill ranks held at `current`: the entry with the latest level <= current wins. */
function heldSkills(skills, current, output) {
  for (const entry of skills) {
    const held = output[entry.id];
    if (entry.level <= current && entry.level >= (held?.from ?? 0)) {
      output[entry.id] = {
        level: entry.rank,
        expiresAt: null,
        from: entry.level,
      };
    }
  }
  return output;
}

function addCapped(vitals, hp, mp) {
  vitals.baseMaxHP = Math.min(30000, vitals.baseMaxHP + hp);
  vitals.baseMaxMP = Math.min(30000, vitals.baseMaxMP + mp);
}

/**
 * Deterministic expected base maxHP/maxMP for a one-off recalculation. Past rolls are
 * unknown, so every Randomizer.rand(min,max) uses trunc((min+max)/2), its truncated mean.
 * - advancements: { [tier]: level } (tier 1..4); missing tiers use the standard levels.
 * - int: INT used for every level's levelUpIntMp; default4 (minimum) is a lower bound.
 * - ap: AP spent on HP/MP, valued at the final job's AssignAP midpoint without skill y.
 * - skills: [{ id, rank, level }]: growth-skill rank held from that character level.
 */
export function expectedBaseVitals(
  {
    job,
    level,
    advancements = {},
    int = 4,
    ap = { hp: 0, mp: 0 },
    skills = [],
  },
  catalog = {},
) {
  experienceRequired(level);
  const at = advancementLevels(job, level, advancements);
  const vitals = {
    baseMaxHP: STARTING_VITALS.hp,
    baseMaxMP: STARTING_VITALS.mp,
  };
  const learned = { job: 0, skills: {} };
  const growth = { hp: 0, mp: 0 };
  let reached = 0;
  for (let current = 1; current <= level; current++) {
    while (at[reached + 1] === current) {
      const bonus = jobAdvancementGrowthRange(jobAtTier(job, ++reached));
      addCapped(vitals, expected(bonus.hp), expected(bonus.mp));
    }
    if (current === level) break;
    learned.job = jobAtTier(job, reached);
    heldSkills(skills, current, learned.skills);
    learnedGrowth(learned, catalog, 0, growth);
    const rolls = levelUpGrowthRange(learned.job);
    addCapped(
      vitals,
      expected(rolls.hp) + growth.hp,
      expected(rolls.mp) + growth.mp + levelUpIntMp(learned.job, int),
    );
  }
  const profile = { job, int, skills: {} };
  const apHp = hpGrowth(profile, catalog),
    apMp = mpGrowth(profile, catalog);
  addCapped(
    vitals,
    ap.hp * (expected(apHp) + apHp[2]),
    ap.mp * (expected(apMp) + apMp[2]),
  );
  return vitals;
}
