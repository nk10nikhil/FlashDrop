import { describe, expect, it } from "vitest";
import { runShutdownSequence } from "../../apps/worker/src/lifecycle.js";

describe("worker graceful shutdown", () => {
  it("drains in order and continues closing resources when one shutdown step fails", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    await runShutdownSequence([
      { name: "stop", run: async () => { calls.push("stop"); } },
      { name: "drain", run: async () => { calls.push("drain"); throw new Error("temporary failure"); } },
      { name: "close-db", run: async () => { calls.push("close-db"); } },
    ], (name) => errors.push(name));
    expect(calls).toEqual(["stop", "drain", "close-db"]);
    expect(errors).toEqual(["drain"]);
  });
});
