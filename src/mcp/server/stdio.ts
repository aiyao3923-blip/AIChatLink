import type { Readable, Writable } from "node:stream";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { KnownTargetOptions } from "../../contracts/index.js";
import { McpBindingRegistry, type McpBindingContext } from "../binding-registry.js";
import type { ToolBrokerApi } from "./broker-api.js";
import { createAIChatLinkMcpServer } from "./tools.js";

export interface AIChatLinkMcpStdioBridge {
  readonly binding: McpBindingContext;
  readonly server: McpServer;
  readonly transport: StdioServerTransport;
  close(): Promise<void>;
}

export interface ConnectAIChatLinkMcpStdioOptions extends KnownTargetOptions {
  readonly broker: ToolBrokerApi;
  readonly bindings: McpBindingRegistry;
  readonly bindingId: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly maxBufferSize?: number;
}

/**
 * Optional process/session-scoped stdio bridge.
 *
 * Stdio has no HTTP header, so its binding is fixed by the Adapter when the
 * bridge is connected. The bindingId is still only a provenance association.
 */
export async function connectAIChatLinkMcpStdio(
  options: ConnectAIChatLinkMcpStdioOptions
): Promise<AIChatLinkMcpStdioBridge> {
  const binding = options.bindings.require(options.bindingId);
  const server = createAIChatLinkMcpServer({
    broker: options.broker,
    binding,
    ...(options.knownTargets === undefined ? {} : { knownTargets: options.knownTargets })
  });
  const transport = new StdioServerTransport(
    options.input,
    options.output,
    options.maxBufferSize === undefined ? undefined : { maxBufferSize: options.maxBufferSize }
  );
  await server.connect(transport);

  return {
    binding,
    server,
    transport,
    close: async () => server.close()
  };
}
