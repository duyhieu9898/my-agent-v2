import { describe, expect, it } from "vitest";

import { createSessionKey } from "./session-key.js";

describe("createSessionKey", () => {
  it("creates the primary main session key", () => {
    expect(
      createSessionKey({
        kind: "main",
        agentId: "primary",
      }),
    ).toBe("agent:primary:main");
  });

  it("creates a channel session key", () => {
    expect(
      createSessionKey({
        kind: "channel",
        agentId: "primary",
        channel: "web",
        conversationId: "conversation-1",
      }),
    ).toBe("agent:primary:web:conversation-1");
  });

  it("normalizes segments", () => {
    expect(
      createSessionKey({
        kind: "main",
        agentId: " Primary ",
      }),
    ).toBe("agent:primary:main");
  });

  it("rejects invalid segments", () => {
    expect(() =>
      createSessionKey({
        kind: "channel",
        agentId: "primary",
        channel: "web",
        conversationId: "invalid conversation",
      }),
    ).toThrow();
  });
});
