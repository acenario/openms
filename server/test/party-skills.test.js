import { expect, test } from "bun:test";
import { content, fixture } from "./party-fixture.js";
import { combatOperation } from "../src/combat-rewards.js";
import {
  advanceActorSkills,
  castSkill,
  synchronizeActorSkills,
  disposeActorSkills,
  prepareActorSkills,
} from "../src/field-skills.js";
import { prepareActorCombat } from "../src/field-combat.js";
import { partySkillTargets } from "../src/party-skills.js";
import { syncSkillDiseases } from "../src/skill-durable-state.js";

function cast(probe, skillId) {
  const actor = probe.actors[0];
  return castSkill(
    probe.world,
    actor,
    { skillId },
    combatOperation(actor, "skill.cast"),
  );
}

test("party buff reaches only same-field members in range and survives unlearned-recipient restoration", async () => {
  const probe = await fixture(412, [4101004]);
  const [caster, member, distant, outsider] = probe.actors;
  const result = await cast(probe, 4101004);
  expect(result.status).toBe("committed");
  expect(member.skills.derived().speed).toBe(40);
  expect(caster.skills.derived().speed).toBe(40);
  expect(distant.skills.derived().speed).toBe(0);
  expect(outsider.skills.derived().speed).toBe(0);
  expect(member.skills.level(4101004)).toBe(0);
  disposeActorSkills(member, true);
  expect(member.profile.onlineState.effects).toHaveLength(1);
  prepareActorCombat(probe.world, member);
  await prepareActorSkills(probe.world, member);
  expect(member.skills.derived().speed).toBe(40);
  member.profile = structuredClone(probe.saved.get(member.id));
  await synchronizeActorSkills(probe.world, member);
  expect(member.skills.derived().speed).toBe(40);
  expect(member.skills.level(4101004)).toBe(0);
  expect(
    member.skills.castError(
      content.catalog.ui.skills[4101004],
      content.catalog.ui.skills[4101004].levels[20],
    ),
  ).toContain("learned rank");
});

test("Heal uses one cost and an authoritative pool shared only by eligible recipients", async () => {
  const probe = await fixture();
  const [caster, member, distant, outsider] = probe.actors;
  const mp = caster.profile.mp;
  await cast(probe, 2301002);
  expect(caster.profile.mp).toBe(mp - 24);
  expect(caster.profile.hp).toBe(1000);
  expect(member.profile.hp).toBe(1000);
  expect(distant.profile.hp).toBe(100);
  expect(outsider.profile.hp).toBe(100);
});

test("Resurrection restores a dead member and persists its caster cooldown", async () => {
  const probe = await fixture();
  const [caster, member] = probe.actors;
  member.profile.hp = 0;
  member.skillField.synchronizeProfile();
  await cast(probe, 2321006);
  expect(member.profile.hp).toBe(1000);
  expect(member.skillField.dead).toBe(false);
  caster.profile = structuredClone(probe.saved.get(caster.id));
  await synchronizeActorSkills(probe.world, caster);
  expect(caster.skills.states.get(2321006).cooldown).toBe(1800000);
});

test("Dispel changes recipient disease state through the committed profile", async () => {
  const probe = await fixture();
  const member = probe.actors[1];
  member.skillField.diseases.remaining[120] = 30000;
  member.skillField.diseases.values[120] = 1;
  syncSkillDiseases(member, probe.world.now);
  await cast(probe, 2311001);
  expect(member.skillField.diseases.has(120)).toBe(false);
  expect(probe.saved.get(member.id).onlineState.diseases).toEqual([]);
});

test("Time Leap resets party skill cooldowns while preserving item and own cooldowns", async () => {
  const probe = await fixture(512, [5121010]);
  const [caster, member] = probe.actors;
  member.profile.onlineState.cooldowns = {
    "skill:1001": probe.world.now + 30000,
    "item.use": probe.world.now + 500,
  };
  await synchronizeActorSkills(probe.world, member);
  await cast(probe, 5121010);
  expect(member.skills.states.get(1001).cooldown).toBe(0);
  expect(member.profile.onlineState.cooldowns["item.use"]).toBeGreaterThan(
    probe.world.now,
  );
  expect(caster.skills.states.get(5121010).cooldown).toBe(1200000);
});

test("no resources or recipients change when a recipient cannot accept the transaction", async () => {
  const probe = await fixture(412, [4101004]);
  const [caster, member] = probe.actors;
  const before = caster.profile.mp;
  member.skillTask = Promise.resolve();
  await expect(cast(probe, 4101004)).rejects.toMatchObject({
    code: "SERVER_BUSY",
  });
  expect(caster.profile.mp).toBe(before);
  expect(member.profile.onlineState.effects).toEqual([]);
  member.skillTask = null;
  const skill = content.catalog.ui.skills[4101004];
  member.profile.social.party = null;
  expect(
    partySkillTargets(probe.world, caster, skill, skill.levels[20]),
  ).toEqual([caster]);
});

test("a buff's published expiry stays fixed while a transaction holds the skill clock", async () => {
  const probe = await fixture(200, [2001002]);
  const caster = probe.actors[0];
  await cast(probe, 2001002);
  const row = caster.profile.onlineState.effects.find(
    (effect) => effect.templateId === 2001002,
  );
  const expiresAt = row.expiresAt;
  for (let tick = 0; tick < 100; tick++) {
    probe.world.now += 30;
    caster.pending = tick % 2 === 0 ? {} : null;
    advanceActorSkills(probe.world, caster);
  }
  caster.pending = null;
  probe.world.now += 30;
  advanceActorSkills(probe.world, caster);
  expect(row.expiresAt).toBe(expiresAt);
});
