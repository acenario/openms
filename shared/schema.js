/** Closed wire-schema machinery. Collection work is bounded before traversal. */
export function protocolError(code = "INVALID_MESSAGE") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateRecordObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw protocolError();
  }
}

export function closedRecord(value, requiredKeys, optionalKeys = []) {
  validateRecordObject(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > requiredKeys.length + optionalKeys.length) {
    throw protocolError();
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) throw protocolError();
  }
  for (const key of keys) {
    if (!requiredKeys.includes(key) && !optionalKeys.includes(key)) {
      throw protocolError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw protocolError();
    }
  }
  return value;
}

export const number = (minimum, maximum, integer = true) => ({
  type: "number",
  minimum,
  maximum,
  integer,
});
export const enumeration = (...values) => ({ type: "enum", values });
export const string = (pattern, maxLength) => ({
  type: "string",
  pattern,
  maxLength,
});
export const array = (item, maximum, minimum = 0, unique = null) => ({
  type: "array",
  item,
  maximum,
  minimum,
  unique,
});
export const nullable = (item) => ({ type: "nullable", item });
export const optional = (item) => ({ type: "optional", item });
export const union = (tag, variants) => ({
  type: "union",
  tag,
  variants: new Map(Object.entries(variants)),
});
export function record(fields, check = null) {
  const required = [],
    optionals = [];
  for (const [key, value] of Object.entries(fields)) {
    (value.type === "optional" ? optionals : required).push(key);
  }
  return { type: "record", fields, required, optionals, check };
}
export const boolean = enumeration(true, false);
export const integer = number(
  -Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER,
);
export const u32 = number(0, 4294967295);
export const revision = number(0, Number.MAX_SAFE_INTEGER);
export const seq = number(1, Number.MAX_SAFE_INTEGER);
export const coordinate = number(-1048576, 1048576, false);
export const point = record({ x: coordinate, y: coordinate });
export const id = string(/^[A-Za-z0-9_-]{1,64}$/, 64);
export const hash = string(/^[a-f0-9]{64}$/, 64);
export const text = { type: "text", maxChars: 256, maxBytes: 1024 };
// Fork policy: chat carries conversation between players and agents, so it gets its own,
// larger bound; every other text field (names, notes, labels) keeps the default above.
export const chatText = { type: "text", maxChars: 2000, maxBytes: 8000 };

/** Reject lone surrogates rather than replacing them during UTF-8 encoding. */
export function validUnicode(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validateNumber(value, schema) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    value >= schema.minimum &&
    value <= schema.maximum &&
    (!schema.integer || Number.isSafeInteger(value))
  );
}

function validateText(value, schema) {
  if (
    typeof value !== "string" ||
    value.length > schema.maxChars * 2 ||
    !validUnicode(value)
  ) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return false;
  }
  return (
    [...value].length <= schema.maxChars &&
    new TextEncoder().encode(value).byteLength <= schema.maxBytes
  );
}

function validateScalar(value, schema) {
  if (Object.is(value, -0)) return false;
  if (schema.type === "number") return validateNumber(value, schema);
  if (schema.type === "enum") return schema.values.includes(value);
  if (schema.type === "string") {
    return (
      typeof value === "string" &&
      value.length <= schema.maxLength &&
      schema.pattern.test(value) &&
      validUnicode(value)
    );
  }
  return schema.type === "text" && validateText(value, schema);
}

function resolveSchema(value, schema) {
  let current = schema;
  for (let i = 0; i < 8; i++) {
    if (current.type === "nullable" && value === null) return enumeration(null);
    if (current.type === "nullable" || current.type === "optional") {
      current = current.item;
    } else if (current.type === "union") {
      if (value === null || typeof value !== "object") throw protocolError();
      const tag = Object.getOwnPropertyDescriptor(value, current.tag);
      current =
        tag && Object.hasOwn(tag, "value")
          ? current.variants.get(tag.value)
          : null;
      if (!current) throw protocolError();
    } else return current;
  }
  throw protocolError();
}

function pushArrayChildren(value, schema, stack) {
  if (
    !Array.isArray(value) ||
    value.length > schema.maximum ||
    value.length < schema.minimum
  ) {
    throw protocolError();
  }
  const seen = new Set();
  for (const item of value) {
    if (schema.unique !== null) {
      const key = schema.unique === true ? item : schema.unique(item);
      if (seen.has(key)) throw protocolError();
      seen.add(key);
    }
    stack.push({ value: item, schema: schema.item });
  }
}

function pushChildren(value, schema, stack) {
  if (schema.type === "array") {
    pushArrayChildren(value, schema, stack);
    return;
  }
  closedRecord(value, schema.required, schema.optionals);
  for (const key of Object.keys(schema.fields)) {
    if (Object.hasOwn(value, key)) {
      stack.push({ value: value[key], schema: schema.fields[key] });
    }
  }
  if (schema.check && !schema.check(value)) throw protocolError();
}

export function validate(value, schema, maxNodes = 32768) {
  const stack = [{ value, schema }];
  for (let count = 0; stack.length > 0; count++) {
    if (count >= maxNodes) throw protocolError();
    const node = stack.pop();
    const resolved = resolveSchema(node.value, node.schema);
    if (resolved.type === "record" || resolved.type === "array") {
      pushChildren(node.value, resolved, stack);
    } else if (!validateScalar(node.value, resolved)) throw protocolError();
  }
  return value;
}

function pushCanonicalChildren(node, resolved, stack) {
  const isArray = resolved.type === "array";
  const keys = isArray
    ? Array.from(node.value.keys())
    : Object.keys(resolved.fields).filter((key) =>
        Object.hasOwn(node.value, key),
      );
  stack.push(isArray ? "]" : "}");
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i];
    stack.push({
      value: node.value[key],
      schema: isArray ? resolved.item : resolved.fields[key],
    });
    if (!isArray) stack.push(JSON.stringify(key) + ":");
    if (i > 0) stack.push(",");
  }
}

/** Encoding order is schema declaration order, independent of incoming JSON order. */
export function canonical(value, schema) {
  validate(value, schema);
  const output = [],
    stack = [{ value, schema }];
  for (let count = 0; stack.length > 0; count++) {
    if (count >= 65536) throw protocolError();
    const node = stack.pop();
    if (typeof node === "string") {
      output.push(node);
      continue;
    }
    const resolved = resolveSchema(node.value, node.schema);
    if (resolved.type !== "record" && resolved.type !== "array") {
      output.push(JSON.stringify(node.value));
      continue;
    }
    output.push(resolved.type === "array" ? "[" : "{");
    pushCanonicalChildren(node, resolved, stack);
  }
  return output.join("");
}
