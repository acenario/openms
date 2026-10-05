import { expect, test } from "bun:test";
import { QUEST_1037, compileQuests } from "./fixtures/quest-1037.js";

const ZERO_PAGE =
  "No authored Say dialogue pages; embedded Act text is not substituted";

function withStage(domain, stage) {
  const images = structuredClone(QUEST_1037);
  if (stage === undefined) delete images[domain][1037][1];
  else images[domain][1037][1] = stage;
  return compileQuests(images).records[1037];
}

// 00717740/00717963 return 1 for an empty page list, so the action is sent.
test("a completion stage with only authored stop text is admitted", () => {
  const record = compileQuests(QUEST_1037).records[1037];
  expect(record.blockers).toEqual([]);
  expect(record.supported).toBe(true);
  expect(record.stages[1].say.pages).toEqual([]);
  expect(record.stages[1].say.stop.mob).toHaveLength(1);
});

test("an empty Say stage whose Act retains numeric text stays blocked", () => {
  const record = withStage("Act.img", { 0: "Act-only text", exp: 60 });
  expect(record.supported).toBe(false);
  expect(record.blockers).toEqual([
    { source: "Quest.wz:Say.img/1037/1", reason: ZERO_PAGE },
  ]);
});

// An absent node follows the caller's argument at 0071736c, not established.
test("an absent Say stage stays blocked", () => {
  const record = withStage("Say.img", undefined);
  expect(record.supported).toBe(false);
  expect(record.blockers).toEqual([
    {
      source: "Quest.wz:Say.img/1037/1",
      reason: "Missing Say dialogue stage",
    },
  ]);
});
