import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DANGLING_NPC_FRAME_UOL,
  bodyRectangle,
  danglingFrameUol,
} from "../tools/life-data.js";
import {
  preflightFindings,
  preflightInputs,
} from "../tools/preflight-inputs.js";
import { finalizePreflight } from "../tools/preflight.js";

function rectangleFrame(root, name, properties) {
  const node = { name, type: "Canvas", parent: root, children: {} };
  for (const [key, value] of Object.entries(properties)) {
    node.children[key] = {
      name: key,
      value,
      type: "Shape2D#Vector2D",
      parent: node,
      children: {},
    };
  }
  return node;
}

function reportState() {
  return {
    sources: {},
    dependencies: {},
    failures: [],
    normalizations: [],
    selection: { ids: ["801010000", "801020000"] },
  };
}

test("independent malformed rectangles retain raw fields and all shared template owners", () => {
  const report = reportState(),
    findings = preflightFindings(report);
  const source = "Mob.wz:9400100.img";
  const root = { source, parent: null, children: {} };
  const partial = rectangleFrame(root, "3", {
    lt: { x: "invalid", y: 0 },
    rb: { x: 14, y: 0 },
  });
  const inverted = rectangleFrame(root, "4", {
    lt: { x: 2, y: 0 },
    rb: { x: 1, y: 0 },
  });
  for (const frame of [partial, inverted, partial]) {
    findings.check(
      frame,
      "lt,rb",
      { lt: frame.children.lt?.value ?? null, rb: frame.children.rb.value },
      () => bodyRectangle(frame),
    );
  }
  finalizePreflight({
    report,
    templateOwners: new Map([
      [source, { npcIds: new Set(), mobIds: new Set(["9400100", "9400101"]) }],
    ]),
    context: {
      owners: new Map([[source, new Set(report.selection.ids)]]),
      dependencies: new Map(
        report.selection.ids.map((id) => [id, new Set([source])]),
      ),
    },
  });
  expect(report.status).toBe("fail");
  expect(report.failures).toHaveLength(2);
  expect(report.failures[0]).toMatchObject({
    archive: "Mob.wz",
    path: "9400100.img",
    field: "3/lt,rb",
    raw: { lt: { x: "invalid", y: 0 }, rb: { x: 14, y: 0 } },
    mapIds: report.selection.ids,
    mobIds: ["9400100", "9400101"],
  });
  expect(report.dependencies["801020000"]).toEqual([source]);
});

test("an absent body corner deactivates that frame instead of inheriting geometry", () => {
  const root = { source: "Mob.wz:9400100.img", parent: null, children: {} };
  const previous = rectangleFrame(root, "2", {
    lt: { x: -80, y: -75 },
    rb: { x: 14, y: 0 },
  });
  const missingLeft = rectangleFrame(root, "3", { rb: { x: 14, y: 0 } });
  const missingRight = rectangleFrame(root, "4", { lt: { x: -80, y: -75 } });
  Object.assign(missingLeft, { width: 200, height: 100 });
  expect(bodyRectangle(previous)).toEqual({
    left: -80,
    top: -75,
    right: 14,
    bottom: 0,
  });
  expect(bodyRectangle(missingLeft)).toBeNull();
  expect(bodyRectangle(missingRight)).toBeNull();
  expect(() =>
    bodyRectangle(rectangleFrame(root, "5", { rb: { x: 14 } })),
  ).toThrow();
});

test("corrupt source boundaries remain owned and do not prevent unrelated source attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maple-preflight-"));
  const report = reportState(),
    findings = preflightFindings(report);
  const context = preflightInputs(directory, report);
  try {
    await writeFile(join(directory, "Map.wz"), Buffer.from("not a WZ archive"));
    for (const mapId of report.selection.ids) {
      context.setOwner(mapId);
      findings.check(null, "", undefined, () =>
        context.image("Map", "Map/Map8/801010000.img"),
      );
    }
    context.setOwner("801020000");
    findings.check(null, "", undefined, () =>
      context.image("Sound", "Bgm00.img"),
    );
    finalizePreflight({ report, context, templateOwners: new Map() });
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0]).toMatchObject({
      code: "image-boundary",
      mapIds: report.selection.ids,
    });
    expect(report.failures[1]).toMatchObject({
      source: "Sound.wz:Bgm00.img",
      mapIds: ["801020000"],
    });
    expect(report.dependencies["801020000"]).toContain("Sound.wz:Bgm00.img");
    expect(report.status).toBe("fail");
  } finally {
    context.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("only the recorded Npc.wz say/14 UOL of the recorded image bytes is omitted", () => {
  const known = DANGLING_NPC_FRAME_UOL;
  const frame = (raw, name = "14") => {
    const root = { name: "", type: "Property", parent: null, children: {} };
    root.source = known.source;
    const say = { name: "say", type: "Property", parent: root, children: {} };
    return { name, type: "UOL", value: raw, parent: say, children: {} };
  };
  const original = { sourceSha256: () => known.sha256 };
  expect(danglingFrameUol(original, frame("../4"))).toBe(true);
  expect(danglingFrameUol(original, frame("4"))).toBe(false);
  expect(danglingFrameUol(original, frame("../4", "13"))).toBe(false);
  expect(
    danglingFrameUol({ sourceSha256: () => "0".repeat(64) }, frame("../4")),
  ).toBe(false);
});
