#!/usr/bin/env node
// Entry wrapper for one pi role.
//
// AIChatLink's resolveAgentCommand allows exactly one JavaScript prefix argument
// (`single_entrypoint_required`), so the role id cannot travel on argv. Each
// role therefore gets its own thin entry file that names the role.

import { main } from "../shim.mjs";

const roleId = "pi-architect";
await main(roleId);
