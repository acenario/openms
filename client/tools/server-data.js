import {
  compileReactorReward,
  reactorDropContent,
} from "./reactor-reward-compiler.js";
import { readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSql, MAX_SQL_BYTES } from "./sql-data.js";
import { hash, resource } from "./atlas.js";
import { compileNpcScript } from "./npc-script-compiler.js";
import { compileNpcRoutes } from "./npc-script-routes.js";
import { compileTutorialPortal } from "./portal-data.js";
import { compilePortalScript } from "./portal-script-compiler.js";
import { compileTransportSchedule } from "./transport-schedule-compiler.js";
import { TUTORIAL_PORTAL_PROGRAMS } from "../src/npc/npc-script-portals.js";
import {
  sourcePaths as configuredSources,
  parseFlags,
} from "./source-options.js";

const DB_ROOT = "src/main/resources/db";
const POLICY_KEYS = [
  "USE_CPQ",
  "USE_ENABLE_SOLO_EXPEDITIONS",
  "USE_AUTOASSIGN_STARTERS_AP",
  "USE_STARTING_AP_4",
  "USE_ENFORCE_JOB_SP_RANGE",
  "USE_PARTY_FOR_STARTERS",
];
const MAX_POLICY_BYTES = 4096;
const MAX_FILES = 10000;
const MAX_SQL_FILES = 128;
const MAX_TOTAL_BYTES = 64000000;
const MAX_SCRIPT_BYTES = 1000000;
const MAX_TOTAL_ROWS = 200000;
const SCRIPT_PROGRESS_INTERVAL = 100;
const DOMAINS = Object.freeze({
  shops: ["shops", "shopitems"],
  drops: ["drop_data", "drop_data_global", "reactordrops"],
  crafting: [
    "makercreatedata",
    "makerrecipedata",
    "makerrewarddata",
    "makerreagentdata",
  ],
  cards: ["monstercarddata"],
  cash: ["specialcashitems", "nxcoupons"],
});
const AUTHORITY = "Cosmic-authorized-server-reference-not-original-client";

async function sourceFile(root, source, maximum) {
  const file = Bun.file(resolve(root, source));
  if (file.size > maximum) throw new Error(`Source byte limit: ${source}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > maximum) {
    throw new Error(`Source changed beyond byte limit: ${source}`);
  }
  return {
    source,
    bytes: bytes.length,
    sha256: hash(bytes),
    text: bytes.toString("utf8"),
  };
}

/** Directory walk is iterative, bounded, sorted, and refuses symbolic links. */
async function sourcePaths(root, directory, extension) {
  const queue = [directory],
    paths = [];
  let entries = 0;
  for (let index = 0; index < queue.length; index++) {
    const children = await readdir(resolve(root, queue[index]), {
      withFileTypes: true,
    });
    entries += children.length;
    if (entries > MAX_FILES) throw new Error("Gameplay input file limit");
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const path = queue[index] ? `${queue[index]}/${child.name}` : child.name;
      if (child.isSymbolicLink()) {
        throw new Error(`Gameplay input symlink unsupported: ${path}`);
      }
      if (child.isDirectory()) queue.push(path);
      else if (child.isFile() && child.name.endsWith(extension)) {
        paths.push(path);
      }
    }
  }
  return paths.sort();
}

export async function readSqlInventory(root, progress) {
  const files = [],
    parsed = [];
  let bytes = 0;
  for (const directory of ["tables", "data"]) {
    progress?.(`Reference SQL: scanning ${resolve(root, directory)}`);
    const paths = await sourcePaths(root, directory, ".sql");
    if (paths.length + files.length > MAX_SQL_FILES) {
      throw new Error("SQL file limit");
    }
    for (const path of paths) {
      const source = `${DB_ROOT}/${path}`;
      progress?.(`Gameplay content: reading and parsing SQL ${source}`);
      const file = await sourceFile(root, path, MAX_SQL_BYTES);
      bytes += file.bytes;
      if (bytes > MAX_TOTAL_BYTES) throw new Error("SQL aggregate byte limit");
      const sql = parseSql(file.text);
      parsed.push(sql);
      files.push({
        source,
        bytes: file.bytes,
        sha256: file.sha256,
        role: directory === "tables" ? "schema" : "companion-data",
        statements: sql.statementCount,
        schemas: sql.schemas.map((schema) => schema.table),
        inserts: sql.inserts.map((insert) => ({
          table: insert.table,
          columns: insert.columns,
          rows: insert.rowCount,
          convertedRows: insert.rows?.length ?? 0,
        })),
        unsupported: sql.unsupported,
      });
    }
  }
  return { files, parsed };
}

function collectTables(inventory) {
  const tables = Object.create(null);
  for (let index = 0; index < inventory.files.length; index++) {
    for (const schema of inventory.parsed[index].schemas) {
      if (tables[schema.table]) {
        throw new Error(`Duplicate SQL schema: ${schema.table}`);
      }
      tables[schema.table] = {
        ...schema,
        source: inventory.files[index].source,
        rows: 0,
        convertedRows: 0,
        dataSources: [],
      };
    }
  }
  let rows = 0;
  for (let index = 0; index < inventory.files.length; index++) {
    for (const insert of inventory.parsed[index].inserts) {
      const table = tables[insert.table];
      if (!table) {
        throw new Error(`INSERT has no supplied schema: ${insert.table}`);
      }
      const names = new Set(
        table.columns.map((column) => column.name.toLowerCase()),
      );
      for (const column of insert.columns) {
        if (!names.has(column.toLowerCase())) {
          throw new Error(`Unknown INSERT column: ${insert.table}.${column}`);
        }
      }
      table.rows += insert.rowCount;
      table.convertedRows += insert.rows ? insert.rows.length : 0;
      rows += insert.rowCount;
      if (rows > MAX_TOTAL_ROWS) {
        throw new Error("Gameplay input total row limit");
      }
      const source = inventory.files[index].source;
      if (!table.dataSources.includes(source)) table.dataSources.push(source);
    }
  }
  return tables;
}

/** Only numeric NPC sources have a unique original String.wz default-talk owner. */
function scriptDefaultTalk(source, defaultTalkForNpc) {
  const id = /^scripts\/npc\/(\d{1,8})\.js$/.exec(source)?.[1];
  if (!id || !defaultTalkForNpc) return undefined;
  return defaultTalkForNpc(Number(id));
}

/** Script compilation requires lossless UTF-8, unlike byte-only inventory. */
async function scriptFile(root, source) {
  const file = await sourceFile(root, source, MAX_SCRIPT_BYTES);
  if (hash(Buffer.from(file.text, "utf8")) !== file.sha256) {
    throw new Error(
      `NPC source must round-trip original UTF-8 bytes: ${source}`,
    );
  }
  return file;
}

function collectPortal(source, file, inventory, options) {
  const script = source.slice("scripts/portal/".length, -3);
  if (Object.hasOwn(TUTORIAL_PORTAL_PROGRAMS, script)) {
    inventory.portalPrograms[script] = compileTutorialPortal({
      script,
      text: file.text,
    });
    return null;
  }
  const compilation = compilePortalScript({
    text: file.text,
    path: source,
    sha256: file.sha256,
    staticConfig: options.staticConfig,
    originalQuestIds: options.originalQuestIds,
  });
  inventory.portalScripts[script] = compilation;
  return compilationSummary(compilation);
}

/** One source's category compiler; other categories stay byte inventories. */
function compileScript(state, category, path, { record, file }) {
  const { options, staticConfig } = state;
  if (category === "npc") {
    const compilation = compileNpcScript({
      text: file.text,
      path: record.source,
      sha256: file.sha256,
      defaultTalk: scriptDefaultTalk(record.source, options.defaultTalkForNpc),
      staticConfig,
      originalQuestIds: options.originalQuestIds,
      eventManagers: new Set(Object.keys(state.transportSchedules)),
    });
    state.compilations.push(compilation);
    record.sourceText = file.text;
    record.compilation = compilationSummary(compilation);
  } else if (category === "portal") {
    const summary = collectPortal(record.source, file, state, {
      staticConfig,
      originalQuestIds: options.originalQuestIds,
    });
    if (summary) record.compilation = summary;
  } else if (category === "event") {
    const compilation = compileTransportSchedule({
      ...file,
      path: record.source,
    });
    // Only the closed transport cycle runs; other events stay inventories.
    if (compilation.status === "supported") {
      state.transportSchedules[path.slice("event/".length, -3)] = {
        ...compilation,
        travelRate: state.travelRate,
      };
    }
  } else if (category === "reactor") {
    state.reactorPrograms[path.slice("reactor/".length, -3)] =
      compileReactorReward({ ...file, source: record.source });
  }
}

async function scriptInventory(root, options, policy) {
  options.progress?.("Gameplay content: scanning local scripts");
  // Sorted paths compile event/ before npc/: NPC sources admit only published transports.
  const paths = await sourcePaths(root, "", ".js");
  const files = [],
    categories = Object.create(null);
  const state = {
    options,
    staticConfig: policy.staticConfig,
    travelRate: policy.travelRate,
    transportSchedules: Object.create(null),
    compilations: [],
    portalPrograms: Object.create(null),
    portalScripts: Object.create(null),
    reactorPrograms: Object.create(null),
  };
  let bytes = 0;
  for (const path of paths) {
    const source = `scripts/${path}`;
    if (files.length % SCRIPT_PROGRESS_INTERVAL === 0) {
      options.progress?.(
        `Gameplay content: reading/compiling script ${files.length + 1}/${paths.length}: ${source}`,
      );
    }
    const file = await scriptFile(root, path);
    bytes += file.bytes;
    if (bytes > MAX_TOTAL_BYTES) throw new Error("Script aggregate byte limit");
    const parts = source.split("/");
    const category = parts.length > 2 ? parts[1] : "root";
    categories[category] = (categories[category] ?? 0) + 1;
    const record = { source, bytes: file.bytes, sha256: file.sha256 };
    compileScript(state, category, path, { record, file });
    files.push(record);
  }
  options.progress?.(`Gameplay content: ${files.length} scripts inventoried`);
  return {
    status:
      "npc-complete-source-compiler; verified-tutorial-portals; portal-scripts-through-npc-compiler; other-categories-inventoried",
    categories,
    files,
    compilations: state.compilations,
    portalPrograms: state.portalPrograms,
    portalScripts: state.portalScripts,
    reactorPrograms: state.reactorPrograms,
    transportSchedules: state.transportSchedules,
  };
}

function compilationSummary(compilation) {
  return {
    status: compilation.status,
    blockers: compilation.blockers,
    astNodes: compilation.astNodes,
    requirements: compilation.requirements,
    dependencies: compilation.dependencies,
  };
}

function domainData(name, tableNames, inventory, tables) {
  const records = Object.create(null),
    sources = [],
    tableSources = Object.create(null);
  for (const table of tableNames) {
    if (!tables[table]) throw new Error(`Missing reference schema: ${table}`);
    records[table] = [];
    tableSources[table] = [];
  }
  for (let index = 0; index < inventory.files.length; index++) {
    const file = inventory.files[index],
      sql = inventory.parsed[index];
    if (
      file.unsupported.length &&
      !file.source.endsWith("/161-admin-data.sql")
    ) {
      throw new Error(
        `Cannot publish incomplete SQL conversion: ${file.source}`,
      );
    }
    let used = false;
    for (const insert of sql.inserts) {
      if (!Object.hasOwn(records, insert.table)) continue;
      if (!insert.rows) {
        throw new Error(`Unsupported reference rows: ${insert.table}`);
      }
      tableSources[insert.table].push({
        source: file.source,
        sha256: file.sha256,
        bytes: file.bytes,
        firstRow: records[insert.table].length + 1,
        rowCount: insert.rows.length,
      });
      used = true;
      for (const row of insert.rows) {
        const record = Object.create(null);
        for (let column = 0; column < insert.columns.length; column++) {
          record[insert.columns[column]] = row[column];
        }
        records[insert.table].push(record);
      }
    }
    if (used) {
      sources.push({
        source: file.source,
        sha256: file.sha256,
        bytes: file.bytes,
      });
    }
  }
  return {
    schemaVersion: 1,
    authority: AUTHORITY,
    domain: name,
    sources,
    tables: records,
    tableSources,
  };
}

function inventorySummary(inventory, tables, scripts) {
  const rows = Object.values(tables);
  return {
    schemaFiles: inventory.files.filter((file) => file.role === "schema")
      .length,
    dataFiles: inventory.files.filter((file) => file.role === "companion-data")
      .length,
    tables: rows.length,
    schemaOnlyTables: rows.filter((table) => table.rows === 0).length,
    authoredRows: rows.reduce((total, table) => total + table.rows, 0),
    literalRows: rows.reduce((total, table) => total + table.convertedRows, 0),
    unsupportedStatements: inventory.files.reduce(
      (total, file) => total + file.unsupported.length,
      0,
    ),
    scripts: scripts.files.length,
    npcScriptsSupported: scripts.compilations.filter(
      (script) => script.status === "supported",
    ).length,
    npcScriptsBlocked: scripts.compilations.filter(
      (script) => script.status === "blocked",
    ).length,
    portalScriptsSupported: Object.values(scripts.portalScripts).filter(
      (script) => script.status === "supported",
    ).length,
    portalScriptsBlocked: Object.values(scripts.portalScripts).filter(
      (script) => script.status === "blocked",
    ).length,
  };
}

/** Supported portal programs join the packaged dependency closure NPC routes use. */
function publishPortalScripts(shops, portalScripts) {
  const supported = Object.create(null);
  const sets = Object.fromEntries(
    Object.entries(shops.supportedDependencies).map(([key, values]) => [
      key,
      new Set(values),
    ]),
  );
  for (const [script, compilation] of Object.entries(portalScripts)) {
    if (compilation.status !== "supported") continue;
    supported[script] = compilation;
    for (const [key, values] of Object.entries(compilation.dependencies)) {
      if (!sets[key]) throw new Error(`Unknown portal dependency: ${key}`);
      for (const value of values) sets[key].add(value);
    }
  }
  shops.portalScripts = supported;
  shops.supportedDependencies = Object.fromEntries(
    Object.entries(sets).map(([key, values]) => [
      key,
      [...values].sort((a, b) =>
        typeof a === "number" ? a - b : a.localeCompare(b),
      ),
    ]),
  );
  shops.supportedItemIds = shops.supportedDependencies.itemIds;
}

/** Local gameplay settings only; no server implementation, Java hashes or deployment config. */
export async function npcRuntimePolicy(root) {
  const file = await sourceFile(root, "policy.json", MAX_POLICY_BYTES);
  const value = JSON.parse(file.text);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.enhancedCrafting !== false ||
    Object.keys(value).length !== 4 ||
    !value.staticConfig ||
    Array.isArray(value.staticConfig)
  ) {
    throw new Error(
      "Invalid gameplay policy: schemaVersion 1 and enhancedCrafting false required",
    );
  }
  if (
    Object.keys(value.staticConfig).length !== POLICY_KEYS.length ||
    POLICY_KEYS.some((key) => typeof value.staticConfig[key] !== "boolean")
  ) {
    throw new Error(
      "Gameplay policy must contain exactly the supported boolean settings",
    );
  }
  // Cosmic WorldConfig.travel_rate: transport rides/departures take 1/N of the authored time.
  if (
    !Number.isSafeInteger(value.travelRate) ||
    value.travelRate < 1 ||
    value.travelRate > 60
  ) {
    throw new Error("Gameplay policy travelRate must be an integer in 1..60");
  }
  return {
    sources: [
      { source: "scripts/policy.json", sha256: file.sha256, bytes: file.bytes },
    ],
    enhancedCrafting: value.enhancedCrafting,
    equipmentRandomStats: false,
    travelRate: value.travelRate,
    staticConfig: value.staticConfig,
  };
}

/** Compile local gameplay inputs. Source JavaScript and SQL are parsed, never executed. */
export async function convertServerData(options = {}) {
  const root = configuredSources(options).gameplayDefinitionsRoot;
  const sqlRoot = configuredSources(options).sqlRoot;
  options.progress?.(`Gameplay content: reading local policy from ${root}`);
  const policy = await npcRuntimePolicy(root);
  const inventory = await readSqlInventory(sqlRoot, options.progress);
  options.progress?.("Gameplay content: collecting SQL tables");
  const tables = collectTables(inventory);
  const scripts = await scriptInventory(root, options, policy);
  const datasets = Object.create(null);
  for (const [name, names] of Object.entries(DOMAINS)) {
    options.progress?.(`Gameplay content: converting ${name} tables`);
    datasets[name] = domainData(name, names, inventory, tables);
  }
  datasets.drops.reactors = reactorDropContent(
    datasets.drops,
    scripts.reactorPrograms,
  );
  options.progress?.("Gameplay content: compiling NPC routes");
  Object.assign(
    datasets.shops,
    compileNpcRoutes(datasets.shops.tables, scripts.compilations),
  );
  publishPortalScripts(datasets.shops, scripts.portalScripts);
  datasets.shops.transportSchedules = scripts.transportSchedules;
  datasets.shops.sources.push(...policy.sources);
  datasets.shops.npcCraftingPolicy = {
    enhancedCrafting: policy.enhancedCrafting,
    equipmentRandomStats: policy.equipmentRandomStats,
  };
  const summary = inventorySummary(inventory, tables, scripts);
  summary.npcRoutes = datasets.shops.routeSummary;
  const report = {
    schemaVersion: 2,
    authority: AUTHORITY,
    sqlFiles: inventory.files,
    tables: Object.values(tables),
    scripts: {
      status: scripts.status,
      categories: scripts.categories,
      files: scripts.files,
      portalPrograms: scripts.portalPrograms,
    },
    exclusions: [
      "Account, character, inventory, keymap and storage bootstrap rows are not browser reference data; no credentials are published.",
      "Schema-only tables contain no world content. SQL defaults are not seed rows.",
      "NPC compilation admits bounded closed syntax; unknown constructs block a route. Recognized unavailable services stop the selected step before durable effects commit. Four hash-verified tutorial portal programs are admitted; other sentinel portal scripts compile through the NPC compiler (enter(pi) as start) and run only on the online authority; other script categories remain inventories.",
      "SQL prices/drop chances are Cosmic server policy, not original Nexon client authority.",
    ],
    summary,
  };
  // Runtime switches read from the catalog by the server and browser rules.
  const runtimePolicy = {
    USE_PARTY_FOR_STARTERS: policy.staticConfig.USE_PARTY_FOR_STARTERS,
  };
  return { report, datasets, policy: runtimePolicy };
}

/** Uses the same immutable resource publisher and descriptor contract as extraction. */
export async function extractServerData(options) {
  if (!options?.output) {
    throw new Error("Server data output directory is required");
  }
  const output = resolve(options.output);
  const converted = options.converted ?? (await convertServerData(options));
  await mkdir(resolve(output, "references"), { recursive: true });
  const datasets = Object.create(null);
  for (const [name, data] of Object.entries(converted.datasets)) {
    datasets[name] = await resource(
      output,
      "references",
      "json",
      Buffer.from(JSON.stringify(data)),
    );
  }
  const report = await resource(
    output,
    "references",
    "json",
    Buffer.from(JSON.stringify(converted.report)),
  );
  return {
    schemaVersion: 2,
    authority: AUTHORITY,
    policy: converted.policy,
    datasets,
    report,
    summary: converted.report.summary,
    supportedItemIds: converted.datasets.shops.supportedItemIds,
    supportedDependencies: converted.datasets.shops.supportedDependencies,
  };
}

export function cliOptions(args) {
  const values = parseFlags(args, {
    "gameplay-definitions-root": { type: "string" },
    "sql-root": { type: "string" },
    output: { type: "string" },
  });
  return {
    output: values.output,
    sqlRoot: values["sql-root"],
    gameplayDefinitionsRoot: values["gameplay-definitions-root"],
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: bun client/tools/server-data.js --output DIR [--gameplay-definitions-root DIR] [--sql-root DIR]\n" +
        "Defaults: repository infra/gameplay-definitions for gameplay scripts/policy.json; infra/sql for SQL. No external server checkout or environment overrides.\n" +
        "Inventories tables/*.sql and data/*.sql under the SQL root and **/*.js under the gameplay definitions root.\n" +
        "Writes immutable references/{sha256}.json; stdout is deterministic descriptor JSON.\n" +
        "Domains: shops, drops, crafting, cards, cash. Report includes hashes, schemas, row counts, unsupported statements and script identities.\n" +
        "Only CREATE TABLE and literal INSERT VALUES are interpreted; bootstrap SQL subqueries are reported, never executed. Credentials are excluded.\n" +
        "Limits: 16MB/SQL file, 128 SQL files, 100000 rows/SQL file, 200000 total rows, 10000 filesystem entries, 1MB/script, 64MB per source family.\n" +
        "SQL/reference parse failures stop publication; unsupported admin bootstrap expressions are report-only.",
    );
  } else {
    const result = await extractServerData(cliOptions(args));
    console.log(JSON.stringify(result));
  }
}
