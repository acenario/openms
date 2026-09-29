import { join } from "node:path";
import { parseFlags } from "../../client/tools/source-options.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { DelayedTraffic } from "../../client/tools/scenarios/delayed-traffic.js";
import { runRemoteMotion } from "../../client/tools/scenarios/online-remote-motion.js";
import { isolatedOnlineCheck } from "./isolated-online-check.js";

async function seed(database) {
  for (const name of ["mover", "observer"]) {
    const account = await database.createAccount({
      name,
      passwordHash: await Bun.password.hash("password"),
      role: name === "mover" ? "developer" : "player",
    });
    const profile = createProfile({
      mapId: "000050000",
      x: 200,
      y: 335,
      facing: 1,
    });
    profile.name = name;
    profile.settings.BGM.mute = true;
    await database.createCharacter(account.id, profile);
  }
}

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2), {
    output: { type: "string" },
    scope: { type: "string" },
    baseline: { type: "boolean" },
    help: { type: "boolean" },
  });
  if (flags.help) {
    console.log(
      "bun server/tools/check-remote-motion.js [--output DIR] [--scope all|players] [--baseline]\nNative peer walking/jumping and item flight/hover at 500 ms RTT; isolated accounts. Baseline records without repaired-motion assertions.",
    );
  } else {
    const scope = flags.scope ?? "all";
    if (!["all", "players"].includes(scope)) {
      throw new Error("Unknown remote-motion scope");
    }
    const output = flags.output ?? "/tmp/openms-remote-motion",
      timings = {};
    const report = await isolatedOnlineCheck({
      seed,
      output,
      timings,
      network: new DelayedTraffic(500),
      run: (options) =>
        runRemoteMotion({
          ...options,
          scope,
          baseline: Boolean(flags.baseline),
        }),
    });
    report.fixtureTimings = timings;
    await Bun.write(
      join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
    process.exitCode = report.status === "pass" ? 0 : 1;
  }
}
