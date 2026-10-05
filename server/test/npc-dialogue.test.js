import { expect, test } from "bun:test";
import { loadContent } from "../src/content.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { freshLease } from "../src/interaction-common.js";
import { executeNpc } from "../src/interaction-npc.js";
import { openStorage } from "../src/interaction-storage.js";
import { questOffers, executeQuest } from "../src/interaction-quest.js";
import { startQuestDialogue } from "../src/interaction-quest-dialogue.js";
import { createDevelopmentLog } from "../../shared/development-log.js";
import { executeAction } from "../src/actions.js";
import { OnlineWorld } from "../src/world.js";

const content = await loadContent();

function fixture(questId = 1039, npcId = 20100) {
  const events = [];
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
  field.characters.set(actor.id, actor);
  const npc = { id: "npc:fixture", templateId: npcId };
  const world = {
    content,
    actors: new Map([[actor.id, actor]]),
    npc: () => npc,
    publish: (recipient, message) =>
      events.push({ recipient: recipient.id, ...message }),
  };
  const lease = freshLease(actor, npc);
  actor.conversation = lease;
  return { actor, world, lease, events, questId };
}

function answer(probe, value, step = probe.lease.step) {
  return executeNpc(
    probe.actor,
    {
      expectedRevision: step,
      action: {
        kind: "npc.answer",
        conversationId: probe.lease.id,
        step,
        answer: value,
      },
    },
    probe.world,
  );
}

function latest(probe) {
  return probe.events.at(-1).event;
}

test("End Chat closes a quest confirmation without running its authored decline page", async () => {
  const probe = fixture();
  startQuestDialogue(probe.actor, probe.world, probe.lease, probe.questId);
  expect(latest(probe).native.kind).toBe("accept-decline");
  const before = structuredClone(probe.actor.profile);
  expect((await answer(probe, { kind: "cancel" })).status).toBe("committed");
  expect(probe.actor.conversation).toBeNull();
  expect(latest(probe).kind).toBe("dialogue.closed");
  expect(probe.actor.nativeInteractions.size).toBe(0);
  expect(probe.actor.profile).toEqual(before);
});

test("Decline retains original No prose and its final OK; cancellation remains separate", async () => {
  const probe = fixture();
  startQuestDialogue(probe.actor, probe.world, probe.lease, probe.questId);
  await answer(probe, { kind: "yesno", value: false });
  expect(latest(probe)).toMatchObject({
    quest: { mode: "rejected" },
    native: { kind: "say", next: false },
  });
  expect(probe.lease.questDialogue.snapshot().text).toBe(
    content.catalog.quests.records[1039].stages[0].say.no[0].text,
  );
  await answer(probe, { kind: "next" });
  expect(latest(probe).kind).toBe("dialogue.closed");
  expect(probe.actor.profile.quests[1039]).toBeUndefined();
});

test("unfinished quests remain browsable but cannot grant a completion lease or reward", async () => {
  const probe = fixture();
  probe.actor.profile.quests[1039] = { state: 1, kills: {} };
  expect(questOffers(probe.actor, probe.world, probe.lease)).toContainEqual({
    questId: 1039,
    action: "claim",
    state: 1,
    ready: false,
  });
  startQuestDialogue(probe.actor, probe.world, probe.lease, 1039);
  expect(latest(probe)).toMatchObject({
    quest: { mode: "blocked" },
    native: { kind: "say", next: false },
  });
  expect(probe.lease.questDialogue.snapshot().text).toContain("10 each");
  expect(probe.lease.offers).toEqual([]);
  await expect(
    executeQuest(
      probe.actor,
      {
        action: {
          kind: "quest.claim",
          questId: 1039,
          conversationId: probe.lease.id,
          step: probe.lease.step,
        },
      },
      probe.world,
    ),
  ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  await answer(probe, { kind: "cancel" });
  expect(latest(probe).kind).toBe("dialogue.closed");
});

test("menu choices require the current step; cancellation clears even a stale displayed step", async () => {
  const probe = fixture();
  probe.lease.menu = questOffers(probe.actor, probe.world, probe.lease);
  probe.lease.step = 4;
  await expect(
    answer(probe, { kind: "choice", choiceId: 0 }, 3),
  ).rejects.toMatchObject({
    code: "STALE_REVISION",
  });
  expect(probe.actor.conversation).toBe(probe.lease);
  await answer(probe, { kind: "cancel" }, 3);
  expect(probe.actor.conversation).toBeNull();
  expect(latest(probe)).toEqual({
    kind: "dialogue.closed",
    conversationId: probe.lease.id,
  });
});

function open(probe) {
  probe.actor.conversation = null;
  return executeNpc(
    probe.actor,
    {
      expectedRevision: probe.actor.revision,
      action: { kind: "npc.open", npcId: "npc:fixture" },
    },
    probe.world,
  );
}

test("an NPC with no available quest or talk endpoint is an empty interaction", async () => {
  const probe = fixture(null, 1010100); // Original Rina, level-one beginner.
  const before = structuredClone(probe.actor.profile);
  expect((await open(probe)).status).toBe("committed");
  expect(probe.actor.conversation).toBeNull();
  expect(probe.events).toEqual([]);
  expect(probe.actor.profile).toEqual(before);
});

test("Regular Cab advances from introduction to all five original destinations", async () => {
  const probe = fixture(null, 1012000);
  expect((await open(probe)).status).toBe("committed");
  probe.lease = probe.actor.conversation;
  expect(probe.lease.view.kind).toBe("say");
  expect((await answer(probe, { kind: "next" })).status).toBe("committed");
  expect(probe.lease.view.kind).toBe("choice");
  expect(latest(probe).choices).toEqual([0, 1, 2, 3, 4]);
  await answer(probe, { kind: "choice", choiceId: 0 });
  expect(probe.lease.view.kind).toBe("yes-no");
  expect(probe.lease.view.text).toContain("100 mesos");
  await answer(probe, { kind: "yesno", value: true });
  expect(probe.lease.view.text).toContain("don't have enough mesos");
  await answer(probe, { kind: "cancel" });
  expect(probe.actor.conversation).toBeNull();
});

test("End Chat clears expired or failed script leases without executing callbacks or changing a profile", async () => {
  const probe = fixture();
  const before = structuredClone(probe.actor.profile);
  probe.lease.expiresAt = 0;
  probe.lease.view = { kind: "choice" };
  probe.world.npc = () => {
    throw new Error("Expired NPC must not be consulted for cancellation");
  };
  expect((await answer(probe, { kind: "cancel" })).status).toBe("committed");
  expect(probe.actor.conversation).toBeNull();
  expect((await answer(probe, { kind: "cancel" })).status).toBe("committed");
  const replacement = freshLease(probe.actor, {
    id: "new-npc",
    templateId: 1012000,
  });
  probe.actor.conversation = replacement;
  await answer(probe, { kind: "cancel" });
  expect(probe.actor.conversation).toBe(replacement);
  expect(probe.actor.profile).toEqual(before);
});

test("NPC cancellation waits for an active persistence checkpoint before reserving the actor", async () => {
  const probe = fixture();
  const saved = Promise.withResolvers();
  const { actor, world } = probe;
  Object.assign(actor, {
    connection: { data: { epoch: "test", ready: true } },
    lastCheckpoint: 0,
  });
  world.now = 1000;
  world.database = {
    checkpoint: () => saved.promise,
    receipt: async () => null,
  };
  world.participants = {
    producedPending: () => false,
    signalIdle: () => {},
    busy: (current) => current.pending,
    reconcile: async (current, receipt) => receipt,
  };
  OnlineWorld.prototype.checkpoint.call(world, actor);
  expect(actor.pending).toBe(true);
  const receipt = executeAction(
    actor,
    {
      operationId: crypto.randomUUID(),
      connectionEpoch: "test",
      fieldEpoch: actor.field.epoch,
      expectedRevision: 0,
      action: {
        kind: "npc.answer",
        conversationId: probe.lease.id,
        step: 0,
        answer: { kind: "cancel" },
      },
    },
    world,
  );
  await Promise.resolve();
  expect(actor.conversation).toBe(probe.lease);
  saved.resolve();
  expect((await receipt).status).toBe("committed");
  expect(actor.pending).toBe(false);
  expect(actor.checkpointTask).toBeNull();
  expect(actor.conversation).toBeNull();
});

test("known blocked NPC services show a closable availability notice without mutation", async () => {
  const probe = fixture(null, 9209000); // Abdula's unsupported service route.
  const logs = [];
  probe.world.log = createDevelopmentLog("npc-test", {
    write: (line) => logs.push(line),
  });
  const before = structuredClone(probe.actor.profile);
  expect((await open(probe)).status).toBe("committed");
  expect(logs[0]).toContain("9209000");
  expect(logs[0]).toContain("cm.getPlayer().isCygnus");
  probe.lease = probe.actor.conversation;
  expect(probe.lease.unavailable).toBe(true);
  expect(latest(probe).native).toMatchObject({ kind: "say", next: false });
  expect(probe.lease.view.text).toContain("Service unavailable");
  await expect(
    answer(probe, { kind: "choice", choiceId: 1 }),
  ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  await answer(probe, { kind: "next" });
  expect(probe.actor.conversation).toBeNull();
  expect(probe.actor.profile).toEqual(before);
});

function storageProbe(level) {
  const probe = fixture(null, 1012009); // Mr. Lee, Henesys Park storage.
  probe.actor.profile.level = level;
  probe.world.openStorage = (actor, lease) =>
    openStorage(actor, probe.world, lease);
  probe.world.participants = {
    storage: async () => ({ slots: 4, mesos: 0, items: [] }),
  };
  return probe;
}

test("a refused storage opening releases its conversation lease", async () => {
  const probe = storageProbe(10);
  await expect(open(probe)).rejects.toMatchObject({
    code: "REQUIREMENTS_NOT_MET",
  });
  expect(probe.actor.conversation).toBeNull();
  expect(probe.actor.storage).toBeNull();
});

test("a level-15 character still opens Mr. Lee's storage", async () => {
  const probe = storageProbe(15);
  expect((await open(probe)).status).toBe("committed");
  expect(probe.actor.conversation.view.kind).toBe("storage");
  expect(latest(probe)).toMatchObject({ kind: "storage", npcId: 1012009 });
});

test("a failed shop opening releases its conversation lease", async () => {
  const probe = fixture(null, 1011000); // Standard shop fallback route.
  const publish = probe.world.publish;
  probe.world.publish = (recipient, message) => {
    if (message.event?.kind === "shop") throw new Error("delivery failed");
    publish(recipient, message);
  };
  await expect(open(probe)).rejects.toThrow("delivery failed");
  expect(probe.actor.conversation).toBeNull();
  expect(probe.actor.shop).toBeNull();
});
