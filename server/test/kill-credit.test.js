import { expect, test } from "bun:test";
import { fixture } from "./party-fixture.js";
import {
  planKillCredit,
  recordKillDamage,
  assignKillLoot,
} from "../src/kill-credit.js";
import { rewardKill } from "../src/combat-rewards.js";
import { ownsDrop } from "../src/field-drops.js";
import { experienceRequired } from "../../client/src/character/offline-progression.js";

function monster() {
  return {
    id: "credit-test",
    deaths: 0,
    alive: true,
    maxHP: 100,
    hp: 100,
    x: 0,
    y: 0,
    templateId: 100100,
    template: { info: { exp: 100, level: 120 } },
    killDropRows: [],
  };
}

/** Override the published USE_PARTY_EXP_BONUS switch for one world. */
function partyExpPolicy(world, enabled) {
  const { catalog } = world.content;
  world.content = Object.assign(Object.create(world.content), {
    catalog: {
      ...catalog,
      serverData: {
        ...catalog.serverData,
        policy: { USE_PARTY_EXP_BONUS: enabled },
      },
    },
  });
}

function amountsOf(plan) {
  return new Map(plan.rewards.map(({ actor, amount }) => [actor.id, amount]));
}

test("USE_PARTY_EXP_BONUS false: damage pools split equally among nearby living party members, outsiders earn only their damage", async () => {
  const { world, actors } = await fixture();
  const [first, member, distant, outsider] = actors;
  partyExpPolicy(world, false);
  const mob = monster();
  recordKillDamage(first, mob, 60);
  recordKillDamage(outsider, mob, 40);
  const plan = planKillCredit(world, outsider, mob);
  const amounts = new Map(
    plan.rewards.map(({ actor, amount }) => [actor.id, amount]),
  );
  expect(amounts.get(first.id)).toBe(30);
  expect(amounts.get(member.id)).toBe(30);
  expect(amounts.get(outsider.id)).toBe(40);
  expect(amounts.has(distant.id)).toBe(false);
  expect(plan.lootOwner).toBe(first);
  const drops = { requests: [{ ownerUntil: world.now + 1000 }] };
  assignKillLoot(plan, drops);
  expect(ownsDrop(member, drops.requests[0], world.now)).toBe(true);
  expect(ownsDrop(outsider, drops.requests[0], world.now)).toBe(false);
});

test("v83 party EXP: level-weighted shares, top-damager 20% and 5%-per-member bonus; solo unchanged", async () => {
  const { world, actors } = await fixture();
  const [first, member, third, outsider] = actors;
  third.simulation.x = 0;
  first.profile.level = 30;
  member.profile.level = 20;
  third.profile.level = 10;
  const mob = monster();
  recordKillDamage(first, mob, 60);
  recordKillDamage(outsider, mob, 40);
  // Pool 60 over levels 60: personal 60×(0.8×L/60 + MVP 0.2), bonus 15% of it, each rounded.
  expect(amountsOf(planKillCredit(world, outsider, mob))).toEqual(
    new Map([
      [first.id, 41],
      [member.id, 18],
      [third.id, 9],
      [outsider.id, 40],
    ]),
  );
  const solo = monster();
  recordKillDamage(outsider, solo, 100);
  expect(amountsOf(planKillCredit(world, outsider, solo))).toEqual(
    new Map([[outsider.id, 100]]),
  );
  partyExpPolicy(world, false);
  expect(amountsOf(planKillCredit(world, outsider, solo))).toEqual(
    new Map([[outsider.id, 100]]),
  );
});

test("dead, under-level, distant, other-field and one-sided roster entries do not receive passive party credit", async () => {
  const { world, actors } = await fixture();
  const [first, member, distant] = actors;
  const mob = monster();
  recordKillDamage(first, mob, 100);
  const field = member.field;
  for (const change of [
    () => {
      member.field = {};
    },
    () => {
      member.field = field;
      member.simulation.x = distant.simulation.x;
    },
    () => {
      member.simulation.x = 0;
      member.profile.hp = 0;
    },
    () => {
      member.profile.hp = 100;
      member.profile.level = 1;
    },
    () => {
      member.profile.level = 120;
      member.profile.social.party.members.pop();
    },
  ]) {
    change();
    // A lone eligible party member is not a sharer: full pool, no bonus.
    expect(amountsOf(planKillCredit(world, first, mob))).toEqual(
      new Map([[first.id, 100]]),
    );
  }
});

test("respawn starts a new damage ledger and departing contributors do not inflate another share", async () => {
  const { world, actors } = await fixture();
  const [first, , , outsider] = actors;
  const mob = monster();
  recordKillDamage(first, mob, 60);
  recordKillDamage(outsider, mob, 40);
  world.actors.delete(outsider.id);
  // The forfeited 40 is not reassigned: pool 60 → (36 + 3.6) + (24 + 2.4), each part rounded.
  expect(
    planKillCredit(world, first, mob).rewards.reduce(
      (sum, row) => sum + row.amount,
      0,
    ),
  ).toBe(40 + 26);
  mob.deaths++;
  recordKillDamage(first, mob, 1);
  expect(mob.damageCredit.size).toBe(1);
  expect(mob.damageCredit.get(first.id).damage).toBe(1);
});

test("one kill receipt commits every eligible recipient once and validates the wire result", async () => {
  const { world, actors, saved } = await fixture();
  const [first, member] = actors;
  const mob = monster();
  recordKillDamage(first, mob, 100);
  mob.alive = false;
  mob.deaths = 1;
  first.profile.quests[1016] = { state: 1, kills: {} };
  member.profile.quests[1016] = { state: 1, kills: {} };
  await rewardKill(world, first, mob);
  // Equal levels: 100×(0.4 + MVP 0.2) + 10% bonus and 100×0.4 + 10% bonus.
  expect(first.profile.exp).toBe(66);
  expect(member.profile.exp).toBe(44);
  expect(saved.get(member.id).exp).toBe(44);
  expect(first.profile.quests[1016].kills[100100]).toBe(1);
  expect(saved.get(member.id).quests[1016].kills[100100]).toBe(1);
  await rewardKill(world, first, mob);
  expect(first.profile.exp).toBe(66);
  expect(member.profile.exp).toBe(44);
  expect(first.field.dropReservations).toBe(0);
});

test("a level-up reward publishes its original foreign effect to the whole field", async () => {
  const { world, actors } = await fixture();
  const [first, member, distant, outsider] = actors;
  const mob = monster();
  recordKillDamage(first, mob, 60);
  recordKillDamage(outsider, mob, 40);
  first.profile.exp = experienceRequired(first.profile.level) - 30;
  mob.alive = false;
  mob.deaths = 1;
  const publications = [];
  world.publish = (recipient, message) => {
    publications.push({ recipient: recipient.id, message });
  };
  await rewardKill(world, outsider, mob);
  const effects = publications.filter(
    ({ message }) => message.event?.kind === "combat.level-up",
  );
  expect(effects.map(({ recipient }) => recipient).sort()).toEqual(
    [first, member, distant, outsider].map((actor) => actor.id).sort(),
  );
  expect(
    effects.every(({ message }) => message.event.actorId === first.id),
  ).toBe(true);
});

test("an online kill level-up rolls the original Magician HP/MP growth", async () => {
  const { world, actors, saved } = await fixture();
  const [first] = actors;
  const mob = monster();
  recordKillDamage(first, mob, 100);
  first.profile.exp = experienceRequired(first.profile.level) - 30;
  first.profile.int = 100;
  mob.alive = false;
  mob.deaths = 1;
  world.random = () => 0;
  await rewardKill(world, first, mob);
  // Cosmic Character.levelUp: Magician rand(10,14)/rand(22,24) + INT100/20.
  expect(saved.get(first.id).level).toBe(121);
  expect(saved.get(first.id).baseMaxHP).toBe(1000 + 10);
  expect(saved.get(first.id).baseMaxMP).toBe(2000 + 22 + 5);
});
