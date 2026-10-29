import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RotatingLog } from "./log.js";
import { tmpDir } from "./__fixtures__/helpers.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

describe("RotatingLog", () => {
  it("prefixes every line with an ISO timestamp and joins partial chunks", () => {
    const file = path.join(tmpDir(), "a.log");
    const log = new RotatingLog(file, 1_000_000);
    log.write("one\ntw");
    log.write("o\r\nthree");
    log.close();
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines.map((l) => l.replace(ISO, ""))).toEqual(["one", "two", "three"]);
    for (const l of lines) expect(l).toMatch(ISO);
  });

  it("rotates to .1 before a write would pass maxBytes", () => {
    const file = path.join(tmpDir(), "b.log");
    const log = new RotatingLog(file, 1000);
    for (let i = 0; i < 100; i++) log.line(`line ${i} ${"x".repeat(20)}`);
    log.close();
    expect(fs.statSync(file).size).toBeLessThanOrEqual(1000);
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(1000);
    expect(fs.readFileSync(file, "utf8").trimEnd().split("\n").at(-1)).toMatch(/line 99 /);
  });

  it("keeps the last 50 lines for error reports", () => {
    const log = new RotatingLog(path.join(tmpDir(), "c.log"), 1_000_000);
    for (let i = 1; i <= 70; i++) log.line(`l${i}`);
    expect(log.tail()).toHaveLength(50);
    expect(log.tail()[0]).toBe("l21");
    log.close();
  });

  it("appends to an existing file and counts its size", () => {
    const file = path.join(tmpDir(), "d.log");
    fs.writeFileSync(file, "y".repeat(990));
    const log = new RotatingLog(file, 1000);
    log.line("next");
    log.close();
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("y".repeat(990));
    expect(fs.readFileSync(file, "utf8")).toMatch(/next\n$/);
  });
});
