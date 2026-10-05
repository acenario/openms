import { familyProgressIds, familyRate } from "./social-family.js";
import { sameParty } from "./party-skills.js";

const MAX_CONTRIBUTORS = 128;
const SHARE_X = 1200;
const SHARE_Y = 600;
const LEVEL_MARGIN = 20;

/** Actual HP removed, before onKill; misses, immunity and overkill contribute nothing. */
export function recordKillDamage(actor, mob, amount) {
  if (!(amount > 0)) return;
  const generation = mob.deaths - (mob.alive ? 0 : 1);
  if (mob.creditGeneration !== generation) {
    mob.creditGeneration = generation;
    mob.damageCredit = new Map();
  }
  const prior = mob.damageCredit.get(actor.id);
  if (!prior && mob.damageCredit.size >= MAX_CONTRIBUTORS) {
    throw new Error("Monster contributor capacity exceeded");
  }
  if (prior) prior.damage += amount;
  else mob.damageCredit.set(actor.id, { actor, damage: amount });
}

function eligible(world, actor, field, mob) {
  return (
    world.actors.get(actor.id) === actor &&
    actor.field === field &&
    actor.state === "active" &&
    !actor.retiring &&
    !actor.deliveryError &&
    actor.profile.hp > 0 &&
    Math.abs(actor.simulation.x - mob.x) <= SHARE_X &&
    Math.abs(actor.simulation.y - mob.y) <= SHARE_Y
  );
}

/** Published USE_PARTY_EXP_BONUS; absent (a pre-policy catalog) means the policy.json default, on. */
export function partyExpBonus(catalog) {
  return catalog?.serverData?.policy?.USE_PARTY_EXP_BONUS !== false;
}

/**
 * Damage earns each party (or solo actor) a pool of WZ EXP for its nearby eligible members.
 * USE_PARTY_EXP_BONUS true: Cosmic GMSv83 Monster.distributePartyExperience; false: OpenMS
 * equal split. See docs/server/remaining-work.md "EXP and loot".
 */
export function planKillCredit(world, killer, mob) {
  const credits = creditEntries(killer, mob);
  const total = credits.reduce((sum, entry) => sum + entry.damage, 0);
  const groups = new Map();
  const ordered = credits.toSorted(
    (a, b) => b.damage - a.damage || a.actor.id.localeCompare(b.actor.id),
  );
  let lootOwner = killer;
  for (const entry of ordered) {
    if (!eligible(world, entry.actor, killer.field, mob)) continue;
    if (!groups.size) lootOwner = entry.actor;
    const key = entry.actor.profile.social.party?.id ?? entry.actor.id;
    let group = groups.get(key);
    if (!group) {
      group = { actor: entry.actor, damage: 0, contributors: [], members: [] };
      groups.set(key, group);
    }
    group.damage += entry.damage;
    group.contributors.push(entry.actor);
  }
  const rewards = [];
  const levelWeighted = partyExpBonus(world.content.catalog);
  // Cosmic rounds the personal and bonus parts separately; OpenMS truncates its one share.
  const round = levelWeighted ? Math.round : Math.trunc;
  for (const group of groups.values()) {
    selectMembers(world, killer.field, mob, group);
    const pool = ((mob.template.info.exp ?? 0) * group.damage) / total;
    const shares = levelWeighted
      ? levelWeightedShares(group, pool)
      : equalShares(group, pool);
    for (const [index, parts] of shares.entries()) {
      const actor = group.members[index];
      const amount = parts.reduce(
        (sum, part) =>
          sum +
          round(adjustedExperience(world, actor, part, mob.showdown ?? 0)),
        0,
      );
      rewards.push({ actor, amount });
    }
  }
  return { rewards, lootOwner, field: killer.field };
}

/** OpenMS: floor the pool, divide equally, remainder ordered by actor ID. */
function equalShares(group, pool) {
  const base = Math.floor(pool);
  const count = group.members.length;
  return group.members.map((_, index) => [
    Math.floor(base / count) + (index < base % count ? 1 : 0),
  ]);
}

/**
 * Cosmic distributePlayerExperience (EXP_SPLIT_COMMON_MOD 0.8, EXP_SPLIT_MVP_MOD 0.2):
 * personal = pool × (0.8 × level / Σlevel + 0.2 for the party's top damager); with two or
 * more members, bonus = personal × 0.05 × members (PARTY_BONUS_EXP_RATE 1). The 0.8/0.2
 * weight is one integer ratio so a solo pool stays exact.
 */
function levelWeightedShares(group, pool) {
  const levels = group.members.reduce((sum, a) => sum + a.profile.level, 0);
  const count = group.members.length;
  return group.members.map((actor) => {
    const mvp = actor === group.contributors[0] ? levels : 0;
    const personal = (pool * (4 * actor.profile.level + mvp)) / (5 * levels);
    return count > 1 ? [personal, (personal * count) / 20] : [personal];
  });
}

function selectMembers(world, field, mob, group) {
  const highest = Math.max(
    ...group.contributors.map((actor) => actor.profile.level),
  );
  const minimum = Math.max(
    1,
    Math.min(highest, mob.template.info.level ?? highest) - LEVEL_MARGIN,
  );
  for (const actor of field.characters.values()) {
    if (!eligible(world, actor, field, mob)) continue;
    if (
      group.contributors.includes(actor) ||
      (sameParty(group.actor, actor) && actor.profile.level >= minimum)
    ) {
      group.members.push(actor);
    }
  }
  group.members.sort((a, b) => a.id.localeCompare(b.id));
}

/** Unrounded: the caller rounds each part per the active split rule. */
function adjustedExperience(world, actor, share, showdown) {
  const holySymbol = actor.skills?.derived().holySymbol ?? 0;
  const curse = actor.skillField?.diseases.has(124) ? 0.5 : 1;
  return (
    share *
    familyRate(actor.profile, "exp", world.now) *
    (1 + holySymbol / 500) *
    (1 + showdown / 100) *
    curse
  );
}

/** Include every affected family before acquiring participant locks. */
export function killCreditIds(plan) {
  const ids = new Set();
  for (const { actor } of plan.rewards) {
    ids.add(actor.id);
    for (const id of familyProgressIds(actor.profile)) ids.add(id);
  }
  return [...ids];
}

export function assignKillLoot(plan, drops) {
  const owner = plan.lootOwner;
  const members = plan.rewards
    .map(({ actor }) => actor)
    .filter((actor) => actor === owner || sameParty(owner, actor))
    .map((actor) => actor.id);
  for (const drop of drops.requests) {
    drop.ownerId = owner.id;
    drop.ownerPartyId = owner.profile.social.party?.id ?? null;
    drop.ownerMemberIds = members;
  }
}

function creditEntries(killer, mob) {
  const credits = mob.damageCredit?.size
    ? [...mob.damageCredit.values()]
    : [{ actor: killer, damage: mob.maxHP }];
  return credits;
}
