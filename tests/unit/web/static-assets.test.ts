import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVED_STATIC_PATHS } from "../../../src/web/server/server.js";

/**
 * The browser loads modules by URL, not by a bundler, so `web/*.ts` only works
 * when `STATIC_ASSETS` also names its compiled `.js`. An unregistered import
 * 404s and takes the whole page down, which no DOM-less test would otherwise
 * notice — see docs/DECISIONS.md D-047 item 4.
 */
describe("browser module allowlist", () => {
  it("serves every module under web/", async () => {
    const webDir = path.resolve(process.cwd(), "web");
    const modules = (await readdir(webDir)).filter((name) => name.endsWith(".ts")).sort();
    expect(modules.length).toBeGreaterThan(0);

    const missing = modules
      .map((name) => name.replace(/\.ts$/u, ""))
      .filter((base) => !SERVED_STATIC_PATHS.includes(`/${base}.js`));

    expect(missing, `unserved browser modules: ${missing.join(", ")}`).toEqual([]);
  });
});
