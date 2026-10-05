import { extractQuests } from "../../tools/quest-data.js";

const MAX_NODES = 512;

/**
 * Original Quest.wz nodes for 1037 "Help Hunt the Snails" (Sam 2005 -> Maria
 * 2103), prose abbreviated. Stage 1 Say has only stop/mob and stop/npc text.
 */
export const QUEST_1037 = {
  "Check.img": {
    1037: {
      0: { npc: 2005, lvmax: 10, job: { 0: 0 } },
      1: { npc: 2103, mob: { 0: { id: 100100, count: 10 } } },
    },
  },
  "Act.img": {
    1037: {
      0: { 0: "흐음...", yes: { 0: "암허스트에..." }, no: { 0: "흠..." } },
      1: { exp: 60, nextQuest: 1038 },
    },
  },
  "Say.img": {
    1037: {
      0: {
        0: "Hmmm... I wonder how Maria is doing...",
        yes: { 0: "Maria, who lives in Amherst...", 1: "#r10 Snails#k..." },
        no: { 0: "Hmmm... You must be really busy with something." },
      },
      1: {
        stop: {
          mob: { 0: "Then please hunt #r10 Snails#k first then talk to me." },
          npc: { 0: "I don't think you went to go see #bMaria#k yet." },
        },
      },
    },
  },
  "QuestInfo.img": { 1037: { name: "Help Hunt the Snails", area: 20 } },
};

/** Bounded original-node-shaped tree, not a live archive dependency. */
function imageTree(input) {
  const root = { name: "", type: "Property", children: {} };
  const queue = [{ input, node: root }];
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > MAX_NODES) throw new Error("Quest fixture node bound");
    const { input: fields, node } = queue[index];
    for (const [name, value] of Object.entries(fields)) {
      const branch = value !== null && typeof value === "object";
      const child = { name, type: branch ? "Property" : "value", children: {} };
      node.children[name] = child;
      if (branch) queue.push({ input: value, node: child });
      else child.value = value;
    }
  }
  return root;
}

export function compileQuests(images) {
  return extractQuests({
    mapIds: [],
    image: (archive, path) =>
      imageTree(archive === "Quest" ? (images[path] ?? {}) : {}),
  });
}
