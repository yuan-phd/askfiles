import http from "node:http";
import type net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { waitForHealthy } from "./health.js";
import { allocatePorts } from "./ports.js";

const servers: http.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as net.AddressInfo).port}/x`)));
}

describe("waitForHealthy", () => {
  it("returns healthy once the URL answers 200", async () => {
    let calls = 0;
    const url = await serve((_, res) => {
      res.statusCode = ++calls < 3 ? 503 : 200;
      res.end();
    });
    expect(await waitForHealthy(url, { timeoutMs: 2000, intervalMs: 10 })).toBe("healthy");
    expect(calls).toBe(3);
  });

  it("returns timeout when nothing listens", async () => {
    const [port] = await allocatePorts(1, "127.0.0.1");
    const t0 = Date.now();
    expect(await waitForHealthy(`http://127.0.0.1:${port}/`, { timeoutMs: 300, intervalMs: 20 })).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });

  it("returns timeout when a request hangs past the deadline", async () => {
    const url = await serve(() => {});
    expect(await waitForHealthy(url, { timeoutMs: 300, intervalMs: 20 })).toBe("timeout");
  });

  it("stops waiting when the process exits", async () => {
    const [port] = await allocatePorts(1, "127.0.0.1");
    const exited = new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    expect(await waitForHealthy(`http://127.0.0.1:${port}/`, { timeoutMs: 5000, intervalMs: 20, exited })).toBe("exited");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
