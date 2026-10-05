import { expect, test } from "bun:test";
import { loadContent } from "../src/content.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { freshLease } from "../src/interaction-common.js";
import { executeNpc } from "../src/interaction-npc.js";
import { questOffers } from "../src/interaction-quest.js";
import {
  QUEST_1037,
  compileQuests,
} from "../../client/test/fixtures/quest-1037.js";

const loaded = await loadContent();
const MARIA = 2103;

function fixture() {
  const quests = loaded.onlineQuests ?? loaded.catalog.quests;
  const record = compileQuests(QUEST_1037).records[1037];
  const content = {
    ...loaded,
    onlineQuests: { ...quests, records: { ...quests.records, 1037: record } },
  };
  const events = [];
  const commits = [];
  const field = { epoch: crypto.randomUUID(), characters: new Map() };
  const actor = {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    session: { expiresAt: Date.now() + 60000 },
    state: "active",
    field,
    profile: createProfile({ mapId: "001010000", x: 0, y: 0, facing: 1 }),
    revision: 1,
  };
  actor.profile.quests[1037] = { state: 1, kills: { 100100: 10 } };
  field.characters.set(actor.id, actor);
  const npc = { id: "npc:maria", templateId: MARIA };
  const world = {
    content,
    actors: new Map([[actor.id, actor]]),
    npc: () => npc,
    publish: (recipient, message) => events.push(message),
    participants: {
      async commit(owner, operation, ids, mutator) {
        const draft = structuredClone(owner.profile);
        const result = await mutator(new Map([[owner.id, draft]]));
        owner.profile = draft;
        commits.push({ operation, result });
        return {
          status: "committed",
          code: "OK",
          domainRevision: result.domainRevision,
          value: result.value,
          events: result.events,
        };
      },
    },
  };
  const lease = freshLease(actor, npc);
  actor.conversation = lease;
  lease.menu = questOffers(actor, world, lease);
  return { actor, world, lease, events, commits };
}

// Original 00717740 returns 1 for an empty Say page list; 00717434 then sends
// the complete action (0x6b, 2) without presenting a dialogue.
test("selecting Maria's zero-page completion commits through executeQuest", async () => {
  const probe = fixture();
  expect(probe.lease.menu).toContainEqual(
    expect.objectContaining({ questId: 1037, action: "claim", ready: true }),
  );
  const step = probe.lease.step;
  const receipt = await executeNpc(
    probe.actor,
    {
      operationId: crypto.randomUUID(),
      fieldEpoch: probe.actor.field.epoch,
      expectedRevision: step,
      action: {
        kind: "npc.answer",
        conversationId: probe.lease.id,
        step,
        answer: { kind: "choice", choiceId: 1037 },
      },
    },
    probe.world,
  );
  expect(receipt).toMatchObject({
    status: "committed",
    value: { kind: "quest.changed", questId: 1037, state: 2 },
  });
  expect(probe.commits).toHaveLength(1);
  expect(probe.commits[0].operation).toMatchObject({
    kind: "npc.answer",
    domain: "conversation",
    domainRevision: step,
  });
  expect(probe.actor.profile.quests[1037].state).toBe(2);
  expect(probe.actor.profile.level).toBe(2); // Act exp 60 crosses level 1.
  expect(probe.actor.conversation).toBeNull();
  expect(probe.events.some((event) => event.event?.kind === "dialogue")).toBe(
    false,
  );
});
