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

test("damage pools split among nearby living party members, outsiders earn only their damage", async () => {
  const { world, actors } = await fixture();
  const [first, member, distant, outsider] = actors;
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

test("dead, under-level and one-sided roster entries do not receive passive party credit", async () => {
  const { world, actors } = await fixture();
  const [first, member] = actors;
  const mob = monster();
  recordKillDamage(first, mob, 100);
  for (const change of [
    () => {
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
    expect(
      planKillCredit(world, first, mob).rewards.map((row) => row.actor.id),
    ).toEqual([first.id]);
  }
});

test("respawn starts a new damage ledger and departing contributors do not inflate another share", async () => {
  const { world, actors } = await fixture();
  const [first, , , outsider] = actors;
  const mob = monster();
  recordKillDamage(first, mob, 60);
  recordKillDamage(outsider, mob, 40);
  world.actors.delete(outsider.id);
  expect(
    planKillCredit(world, first, mob).rewards.reduce(
      (sum, row) => sum + row.amount,
      0,
    ),
  ).toBe(60);
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
  expect(first.profile.exp).toBe(50);
  expect(member.profile.exp).toBe(50);
  expect(saved.get(member.id).exp).toBe(50);
  expect(first.profile.quests[1016].kills[100100]).toBe(1);
  expect(saved.get(member.id).quests[1016].kills[100100]).toBe(1);
  await rewardKill(world, first, mob);
  expect(first.profile.exp).toBe(50);
  expect(member.profile.exp).toBe(50);
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
