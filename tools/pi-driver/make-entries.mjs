#!/usr/bin/env node
// Regenerate entries/<roleId>.mjs from ROLES.json, so adding a role is a
// one-file edit. Also prints the aichatlink.json fragment to paste.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRolesFile } from "./roles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const roles = parseRolesFile(JSON.parse(await readFile(path.join(here, "ROLES.json"), "utf8")));
const entries = path.join(here, "entries");
await mkdir(entries, { recursive: true });

const BOILERPLATE = (roleId) => `#!/usr/bin/env node
// Entry wrapper for one pi role.
//
// AIChatLink's resolveAgentCommand allows exactly one JavaScript prefix argument
// (\`single_entrypoint_required\`), so the role id cannot travel on argv. Each
// role therefore gets its own thin entry file that names the role.

import { main } from "../shim.mjs";

const roleId = "${roleId}";
await main(roleId);
`;

for (const roleId of roles.keys()) {
  await writeFile(path.join(entries, `${roleId}.mjs`), BOILERPLATE(roleId));
  process.stdout.write(`generated entries/${roleId}.mjs\n`);
}

const fragment = {};
for (const [roleId, role] of roles) {
  const entry = path.join(entries, `${roleId}.mjs`).replace(/\\/g, "/");
  fragment[roleId] = {
    driver: "claude",
    name: roleId,
    command: { executable: "node", prefixArgs: [entry] },
    cwd: path.resolve(here, "..", "..").replace(/\\/g, "/"),
    enabled: true,
  };
}
process.stdout.write(`\n--- aichatlink.json agents fragment ---\n${JSON.stringify(fragment, null, 2)}\n`);
