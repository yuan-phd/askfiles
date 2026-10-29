import net from "node:net";
import { describe, expect, it } from "vitest";
import { allocatePorts } from "./ports.js";

describe("allocatePorts", () => {
  it("returns distinct ports that are free to bind right after", async () => {
    const ports = await allocatePorts(3, "127.0.0.1");
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    for (const p of ports) {
      expect(p).toBeGreaterThan(0);
      const s = net.createServer();
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(p, "127.0.0.1", () => resolve());
      });
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("rejects when the host cannot be bound", async () => {
    await expect(allocatePorts(1, "203.0.113.1")).rejects.toThrow();
  });
});
