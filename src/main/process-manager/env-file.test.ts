import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureServerEnvFile, readEnvFile } from "./env-file.js";
import { tmpDir } from "./__fixtures__/helpers.js";

describe("ensureServerEnvFile", () => {
  it("writes the file once with fresh 32 byte secrets and the ports, then never again", () => {
    const file = path.join(tmpDir(), "server", ".env");
    expect(ensureServerEnvFile(file, { serverPort: 40001, collectorPort: 40002 })).toBe(true);
    const first = fs.readFileSync(file, "utf8");
    expect(ensureServerEnvFile(file, { serverPort: 50001, collectorPort: 50002 })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(first);

    const env = readEnvFile(file);
    expect(env.SERVER_PORT).toBe("40001");
    expect(env.COLLECTOR_PORT).toBe("40002");
    expect(env.DISABLE_TELEMETRY).toBe("true");
    const secrets = [env.JWT_SECRET!, env.SIG_KEY!, env.SIG_SALT!];
    for (const s of secrets) expect(Buffer.from(s, "base64")).toHaveLength(32);
    expect(new Set(secrets).size).toBe(3);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps a file someone else wrote", () => {
    const file = path.join(tmpDir(), "server", ".env");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "JWT_SECRET=mine\n");
    expect(ensureServerEnvFile(file, { serverPort: 1, collectorPort: 2 })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("JWT_SECRET=mine\n");
  });

  it("gives different secrets to different installs", () => {
    const a = path.join(tmpDir(), ".env");
    const b = path.join(tmpDir(), ".env");
    ensureServerEnvFile(a, { serverPort: 1, collectorPort: 2 });
    ensureServerEnvFile(b, { serverPort: 1, collectorPort: 2 });
    expect(readEnvFile(a).JWT_SECRET).not.toBe(readEnvFile(b).JWT_SECRET);
  });
});
