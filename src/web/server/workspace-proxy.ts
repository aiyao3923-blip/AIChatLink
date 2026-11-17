import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { WorkspaceProxy } from "./types.js";

interface ProxyEntry {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly upstream: ReturnType<typeof httpRequest>;
}

export interface WorkspaceProxyDependencies {
  /** Writes the existing safe error envelope before any upstream bytes. */
  writeProblem(response: ServerResponse, status: number, message: string): void;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);

/**
 * A loopback-only reverse proxy. The hub forwards room-scoped requests to the
 * child runtime that owns the workspace; children keep their own HTTP server,
 * SQLite database, MCP endpoint and Agent sessions.
 *
 * Proxied streams are tracked separately from `#requestControllers`, so a
 * long-lived SSE connection never blocks graceful shutdown: `closeAll()` tears
 * them down after the hub stops accepting new work.
 */
export function createWorkspaceProxy(dependencies: WorkspaceProxyDependencies): WorkspaceProxy {
  const active = new Set<ProxyEntry>();

  return {
    forward(request, response, url, targetOrigin): Promise<void> {
      const target = new URL(targetOrigin);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        dependencies.writeProblem(response, 502, "Workspace origin is not an HTTP origin");
        return Promise.resolve();
      }
      // The child parses a strict query contract; `ws` is hub routing only.
      url.searchParams.delete("ws");
      const forwardPath = `${url.pathname}${url.search}`;
      const headers: IncomingHttpHeaders = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
          headers[name] = value;
        }
      }

      return new Promise<void>((resolve) => {
        let settled = false;
        let upstreamResponse: IncomingMessage | undefined;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const upstream = httpRequest(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            method: request.method,
            path: forwardPath,
            headers
          },
          (incoming) => {
            upstreamResponse = incoming;
            if (response.destroyed || response.writableEnded) {
              incoming.destroy();
              settle();
              return;
            }
            const responseHeaders: IncomingHttpHeaders = { ...incoming.headers };
            response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, responseHeaders);
            response.flushHeaders();
            incoming.pipe(response);
            incoming.once("end", settle);
            incoming.once("close", settle);
            incoming.once("error", () => {
              if (!response.writableEnded) response.destroy();
              settle();
            });
          }
        );
        const entry: ProxyEntry = { request, response, upstream };
        active.add(entry);
        const cleanup = (): void => {
          active.delete(entry);
          settle();
        };
        request.once("aborted", () => {
          upstream.destroy();
          cleanup();
        });
        response.once("close", () => {
          if (!upstreamResponse?.complete) upstream.destroy();
          cleanup();
        });
        upstream.once("error", () => {
          if (!response.headersSent && !response.destroyed && !response.writableEnded) {
            dependencies.writeProblem(response, 502, "Workspace runtime is unreachable");
          } else if (!response.writableEnded) {
            response.destroy();
          }
          cleanup();
        });
        upstream.once("close", () => {
          if (upstreamResponse === undefined) cleanup();
        });
        request.pipe(upstream);
      });
    },

    closeAll(): void {
      for (const entry of [...active]) {
        active.delete(entry);
        entry.upstream.destroy();
        if (!entry.response.writableEnded) entry.response.destroy();
      }
    }
  };
}
