import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertServerData, npcRuntimePolicy } from "../tools/server-data.js";

const GAMEPLAY_DEFINITIONS_ROOT = resolve(
  import.meta.dir,
  "../../infra/gameplay-definitions",
);

test("gameplay scripts preserve the imported bytes and source identities", async () => {
  const manifest = await Bun.file(
    join(GAMEPLAY_DEFINITIONS_ROOT, "manifest.json"),
  ).json();
  const paths = await Array.fromAsync(
    new Bun.Glob("**/*.js").scan({ cwd: GAMEPLAY_DEFINITIONS_ROOT }),
  );
  expect(manifest.files).toHaveLength(1915);
  expect(paths.sort()).toEqual(manifest.files.map((file) => file.path).sort());
  for (const record of manifest.files) {
    const bytes = await Bun.file(
      join(GAMEPLAY_DEFINITIONS_ROOT, record.path),
    ).arrayBuffer();
    expect(bytes.byteLength).toBe(record.bytes);
    expect(
      createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    ).toBe(record.sha256);
    expect(record.source).toBe(`scripts/${record.path}`);
  }
});

test("conversion needs only local policy and scripts alongside SQL", async () => {
  const root = await mkdtemp(join(tmpdir(), "openms-local-gameplay-"));
  try {
    await Bun.write(
      join(root, "policy.json"),
      Bun.file(join(GAMEPLAY_DEFINITIONS_ROOT, "policy.json")),
    );
    await Bun.write(
      join(root, "npc/9999999.js"),
      'function start() { cm.sendOk("Local dialogue"); cm.dispose(); }',
    );
    const result = await convertServerData({ gameplayDefinitionsRoot: root });
    expect(result.report.scripts.files).toHaveLength(1);
    expect(result.report.scripts.files[0]).toMatchObject({
      source: "scripts/npc/9999999.js",
      compilation: { status: "supported" },
    });
    const policy = await npcRuntimePolicy(root);
    expect(policy.sources.map((file) => file.source)).toEqual([
      "scripts/policy.json",
    ]);
    expect(policy.enhancedCrafting).toBe(false);
    expect(policy.equipmentRandomStats).toBe(false);
    // Cosmic USE_PARTY_FOR_STARTERS defaults off: the original client party rule applies.
    // USE_PARTY_EXP_BONUS defaults on: the Cosmic GMSv83 party EXP split and bonus.
    expect(result.policy).toEqual({
      USE_PARTY_FOR_STARTERS: false,
      USE_PARTY_EXP_BONUS: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local gameplay policy rejects missing, unsupported and oversized settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "openms-gameplay-policy-"));
  const policy = await Bun.file(
    join(GAMEPLAY_DEFINITIONS_ROOT, "policy.json"),
  ).json();
  const invalid = [
    null,
    { ...policy, schemaVersion: 2 },
    { ...policy, enhancedCrafting: true },
    { ...policy, extra: false },
    { ...policy, travelRate: 0 },
    { ...policy, travelRate: 1.5 },
    { ...policy, staticConfig: {} },
    { ...policy, staticConfig: { ...policy.staticConfig, USE_CPQ: "true" } },
    { ...policy, staticConfig: { ...policy.staticConfig, UNKNOWN: false } },
    {
      ...policy,
      staticConfig: { ...policy.staticConfig, USE_PARTY_FOR_STARTERS: 1 },
    },
    {
      ...policy,
      staticConfig: { ...policy.staticConfig, USE_PARTY_EXP_BONUS: "true" },
    },
  ];
  try {
    await expect(npcRuntimePolicy(root)).rejects.toThrow();
    for (const value of invalid) {
      await Bun.write(join(root, "policy.json"), JSON.stringify(value));
      await expect(npcRuntimePolicy(root)).rejects.toThrow();
    }
    await Bun.write(join(root, "policy.json"), " ".repeat(4097));
    await expect(npcRuntimePolicy(root)).rejects.toThrow("byte limit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
