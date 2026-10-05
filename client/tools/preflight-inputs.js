import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { WzArchive } from "../src/assets/wz.js";
import { parseImage } from "../src/assets/image.js";

const SOURCE_PROGRESS_INTERVAL = 100;

/** Retain original byte identity even when the subsequent IMG parse fails. */
function readOriginalImage(reader, name, path, report) {
  const key = `${name}.wz:${path}`;
  report.sources[key] = {
    archive: `${name}.wz`,
    path,
    sha256: createHash("sha256").update(reader.bytes).digest("hex"),
    bytes: reader.bytes.length,
  };
  const node = parseImage(reader);
  node.source = key;
  return node;
}

/** Read-only original IMG ownership. Failed parsing is cached, never replaced by an empty tree. */
export function preflightInputs(assets, report, progress) {
  const archives = new Map(),
    images = new Map(),
    errors = new Map();
  const owners = new Map(),
    dependencies = new Map();
  let owner = null;
  function archive(name) {
    if (!archives.has(name)) {
      progress?.(`Preflight: opening and indexing original ${name}.wz`);
      archives.set(name, new WzArchive(resolve(assets, `${name}.wz`)));
    }
    return archives.get(name);
  }
  function image(name, path) {
    const key = `${name}.wz:${path}`;
    if (!owners.has(key)) owners.set(key, new Set());
    if (owner !== null) {
      owners.get(key).add(owner);
      if (!dependencies.has(owner)) dependencies.set(owner, new Set());
      dependencies.get(owner).add(key);
    }
    if (errors.has(key)) throw errors.get(key);
    if (images.has(key)) return images.get(key);
    try {
      if ((images.size + errors.size) % SOURCE_PROGRESS_INTERVAL === 0) {
        progress?.(
          `Preflight: reading ${key} (${images.size} images parsed, ${errors.size} failed)`,
        );
      }
      const reader = archive(name).imageReader(path);
      const node = readOriginalImage(reader, name, path, report);
      images.set(key, node);
      return node;
    } catch (cause) {
      const error = new Error(`Cannot load ${key}: ${cause.message}`, {
        cause,
      });
      error.source = key;
      error.code = "image-boundary";
      errors.set(key, error);
      throw error;
    }
  }
  return {
    image,
    imageEntries: (name) => archive(name).entries,
    sourceSha256: (key) => report.sources[key]?.sha256 ?? null,
    owners,
    dependencies,
    setOwner: (id) => {
      owner = id;
    },
    close: () => {
      for (const input of archives.values()) input.close();
    },
  };
}

/** Bounded ancestry preserves exact IMG and property provenance through UOL targets. */
export function provenance(node) {
  const path = [];
  for (let depth = 0; node?.parent && depth < 256; depth++) {
    path.push(node.name);
    node = node.parent;
  }
  if (node?.parent) throw new Error("Preflight ancestry exceeds 256 nodes");
  return { source: node?.source ?? "", field: path.reverse().join("/") };
}

export function rawValue(value) {
  if (value === undefined) return { raw: null, valueType: "undefined" };
  if (Buffer.isBuffer(value)) {
    return { raw: value.toString("hex"), valueType: "bytes" };
  }
  const number = encodedNumber(value);
  if (number !== null) {
    return { raw: number, valueType: "number", encoding: "javascript-number" };
  }
  if (value !== null && typeof value === "object") {
    const numericEncoding = {};
    for (const [key, component] of Object.entries(value)) {
      const encoded = encodedNumber(component);
      if (encoded !== null) numericEncoding[key] = encoded;
    }
    if (Object.keys(numericEncoding).length) {
      return {
        raw: { ...value, ...numericEncoding },
        valueType: "object",
        numericEncoding,
      };
    }
  }
  return { raw: value, valueType: value === null ? "null" : typeof value };
}

function encodedNumber(value) {
  if (typeof value !== "number") return null;
  if (Object.is(value, -0)) return "-0";
  return Number.isFinite(value) ? null : String(value);
}

/** Deduplicate only identical findings; source ownership is joined after traversal. */
export function preflightFindings(report) {
  const state = { report, findings: new Map() };
  function add(error, node, field = "", raw = node?.value) {
    return addFinding(state, error, { node, field, raw });
  }
  function check(node, field, raw, validate) {
    try {
      return validate();
    } catch (error) {
      add(error, node, field, raw);
      return null;
    }
  }
  return { add, check };
}

function addFinding(state, error, details) {
  details.origin = provenance(details.node);
  details.source = error.source ?? details.origin.source;
  if (!details.node && error.code !== "image-boundary") {
    const precise = state.report.failures.find(
      (row) =>
        row.source === details.source &&
        row.field &&
        row.message === error.message,
    );
    if (precise) return precise;
  }
  const row = findingRow(error, details);
  const key = JSON.stringify(row);
  if (!state.findings.has(key)) {
    state.findings.set(key, row);
    state.report.failures.push(row);
  }
  const finding = state.findings.get(key);
  if (error.code === "image-boundary" && details.node) {
    addBoundaryReference(finding, details);
  }
  return finding;
}

function findingRow(error, details) {
  const { source, origin, node, field, raw } = details;
  const separator = source.indexOf(":");
  const row = {
    code: error.code ?? "invalid-original",
    message: error.message,
    source,
    archive: source.slice(0, separator),
    path: source.slice(separator + 1),
    field: [origin.field, field].filter(Boolean).join("/"),
    ...rawValue(raw),
    mapIds: [],
    npcIds: [],
    mobIds: [],
    wzType: node?.children[field]?.type ?? node?.type ?? null,
  };
  if (error.code === "image-boundary") {
    row.boundary = "IMG descendants unavailable; unrelated sources continue";
    row.field = "";
    row.raw = null;
    row.valueType = "unavailable";
    row.wzType = null;
  }
  return row;
}

function addBoundaryReference(finding, details) {
  finding.references ??= [];
  const reference = {
    ...details.origin,
    requestedField: details.field,
    ...rawValue(details.raw),
  };
  const key = JSON.stringify(reference);
  if (!finding.references.some((entry) => JSON.stringify(entry) === key)) {
    finding.references.push(reference);
  }
}
