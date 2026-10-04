import { expect, test } from "bun:test";
import { decodeClient, decodeServer } from "../../shared/protocol.js";
import { chatText, text } from "../../shared/schema.js";
import { CHAT_LIMIT } from "../../client/src/social/chat-rules.js";

const chat = (body) =>
  JSON.stringify({
    v: 1,
    type: "command",
    connectionEpoch: "connection",
    seq: 1,
    fieldEpoch: "field",
    operationId: "00000000-0000-4000-8000-000000000000",
    expectedRevision: 0,
    action: { kind: "chat.send", channel: "map", text: body },
  });

const heard = (body) =>
  JSON.stringify({
    v: 1,
    type: "event",
    connectionEpoch: "connection",
    serverTick: 1,
    eventSeq: 1,
    fieldEpoch: "field",
    event: {
      kind: "chat",
      messageId: "m",
      senderId: "s",
      senderName: "Lumen",
      channel: "map",
      text: body,
    },
  });

test("chat carries the fork's long-message bound in both directions", () => {
  expect(CHAT_LIMIT).toBe(chatText.maxChars);
  const longest = "a".repeat(chatText.maxChars);
  expect(decodeClient(chat(longest)).action.text).toBe(longest);
  expect(decodeServer(heard(longest)).event.text).toBe(longest);
  expect(() => decodeClient(chat(`${longest}a`))).toThrow();
  expect(() => decodeServer(heard(`${longest}a`))).toThrow();
});

test("other text fields keep the default 256-character bound", () => {
  expect(text.maxChars).toBe(256);
  expect(chatText.maxChars).toBeGreaterThan(text.maxChars);
});
