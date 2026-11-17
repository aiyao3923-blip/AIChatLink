import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAgentCommand,
  type CommandResolverDependencies
} from "../../../src/launch/command-spec.js";

const paths = path.win32;
const baseDirectory = "C:\\workspace";
const appData = "C:\\Users\\aichatlink\\AppData\\Roaming";
const localAppData = "C:\\Users\\aichatlink\\AppData\\Local";
const userProfile = "C:\\Users\\aichatlink";
const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";

const piEntrypoint = paths.resolve(
  appData,
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js"
);
const workBuddyEntrypoint = paths.resolve(
  localAppData,
  "Programs",
  "WorkBuddy",
  "resources",
  "app.asar.unpacked",
  "cli",
  "dist",
  "codebuddy-lite-wb.mjs"
);

function windowsDependencies(
  files: readonly string[],
  pathValue = "C:\\Tools"
): CommandResolverDependencies {
  const normalizedFiles = new Set(files.map((candidate) => paths.normalize(candidate).toLowerCase()));
  return {
    platform: "win32",
    env: { APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: userProfile, PATH: pathValue },
    execPath: nodeExecutable,
    isFile: (candidate) => normalizedFiles.has(paths.normalize(candidate).toLowerCase())
  };
}

function posixDependencies(
  files: readonly string[],
  pathValue: string
): CommandResolverDependencies {
  const set = new Set(files);
  return {
    platform: "darwin",
    env: { HOME: "/Users/aichatlink", PATH: pathValue },
    execPath: "/opt/homebrew/bin/node",
    isFile: (candidate) => set.has(candidate)
  };
}

const defaultCommand = (driver: string) => ({ executable: driver, prefixArgs: [] as string[] });

describe("pi default command resolution", () => {
  it("resolves the npm pi package through the absolute node runtime on Windows", () => {
    expect(
      resolveAgentCommand("pi", "pi", defaultCommand("pi"), baseDirectory, windowsDependencies([nodeExecutable, piEntrypoint]))
    ).toEqual({ executable: nodeExecutable, prefixArgs: [piEntrypoint] });
  });

  it("does not accept npm's extensionless POSIX shell shim on Windows", () => {
    const shim = "C:\\Tools\\pi";
    expect(() =>
      resolveAgentCommand("pi", "pi", defaultCommand("pi"), baseDirectory, windowsDependencies([shim]))
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });

  it("prefers a native pi.exe on Windows", () => {
    const executable = "C:\\Tools\\pi.exe";
    expect(
      resolveAgentCommand("pi", "pi", defaultCommand("pi"), baseDirectory, windowsDependencies([executable]))
    ).toEqual({ executable, prefixArgs: [] });
  });

  it("uses PATH then the npm prefix on POSIX", () => {
    const onPath = "/usr/local/bin/pi";
    expect(
      resolveAgentCommand("pi", "pi", defaultCommand("pi"), "/workspace", posixDependencies([onPath], "/usr/local/bin"))
    ).toEqual({ executable: onPath, prefixArgs: [] });

    expect(
      resolveAgentCommand(
        "pi",
        "pi",
        defaultCommand("pi"),
        "/workspace",
        posixDependencies(
          [
            "/opt/homebrew/bin/node",
            "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
          ],
          "/usr/bin"
        )
      )
    ).toEqual({
      executable: "/opt/homebrew/bin/node",
      prefixArgs: ["/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"]
    });
  });
});

describe("WorkBuddy default command resolution", () => {
  it("resolves the bundled CodeBuddy stream-json entrypoint on Windows", () => {
    expect(
      resolveAgentCommand(
        "workbuddy",
        "workbuddy",
        defaultCommand("workbuddy"),
        baseDirectory,
        windowsDependencies([nodeExecutable, workBuddyEntrypoint])
      )
    ).toEqual({ executable: nodeExecutable, prefixArgs: [workBuddyEntrypoint] });
  });

  it("prefers a native workbuddy.exe on PATH", () => {
    const executable = "C:\\Tools\\workbuddy.exe";
    expect(
      resolveAgentCommand(
        "workbuddy",
        "workbuddy",
        defaultCommand("workbuddy"),
        baseDirectory,
        windowsDependencies([executable, workBuddyEntrypoint])
      )
    ).toEqual({ executable, prefixArgs: [] });
  });

  it("fails closed when the desktop bundle is absent", () => {
    expect(() =>
      resolveAgentCommand(
        "workbuddy",
        "workbuddy",
        defaultCommand("workbuddy"),
        baseDirectory,
        windowsDependencies([nodeExecutable])
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });

  it("resolves a POSIX codebuddy/cbc CLI from PATH", () => {
    const executable = "/usr/local/bin/cbc";
    expect(
      resolveAgentCommand(
        "workbuddy",
        "workbuddy",
        defaultCommand("workbuddy"),
        "/workspace",
        posixDependencies([executable], "/usr/local/bin")
      )
    ).toEqual({ executable, prefixArgs: [] });
    expect(() =>
      resolveAgentCommand(
        "workbuddy",
        "workbuddy",
        defaultCommand("workbuddy"),
        "/workspace",
        posixDependencies([], "/usr/local/bin")
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });
});

describe("Claude native resolution", () => {
  const packagedNative = paths.resolve(
    appData,
    "npm",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe"
  );

  it("ignores npm's extensionless shell shim and uses the packaged native build", () => {
    expect(
      resolveAgentCommand(
        "claude",
        "claude",
        defaultCommand("claude"),
        baseDirectory,
        windowsDependencies(["C:\Tools\claude", packagedNative])
      )
    ).toEqual({ executable: packagedNative, prefixArgs: [] });
  });

  it("falls back to the older Node entrypoint only when no native build exists", () => {
    const cliJs = paths.resolve(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    expect(
      resolveAgentCommand(
        "claude",
        "claude",
        defaultCommand("claude"),
        baseDirectory,
        windowsDependencies([nodeExecutable, cliJs])
      )
    ).toEqual({ executable: nodeExecutable, prefixArgs: [cliJs] });
  });
});

describe("Windows executable-image guard", () => {
  it("rejects an explicit extensionless or .sh command that Node cannot spawn", () => {
    const extensionless = "C:\Tools\claude";
    expect(() =>
      resolveAgentCommand(
        "reviewer",
        "claude",
        { executable: extensionless, prefixArgs: [] },
        baseDirectory,
        windowsDependencies([extensionless])
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));

    const shellScript = "C:\Tools\runner.sh";
    expect(() =>
      resolveAgentCommand(
        "reviewer",
        "claude",
        { executable: shellScript, prefixArgs: [] },
        baseDirectory,
        windowsDependencies([shellScript])
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });

  it("rejects an extensionless PATH name on Windows", () => {
    const shim = "C:\Tools\hermes";
    expect(() =>
      resolveAgentCommand(
        "hermes",
        "hermes",
        defaultCommand("hermes"),
        baseDirectory,
        windowsDependencies([shim])
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });
});

describe("legacy driver isolation", () => {
  it("keeps kimi on its own npm entrypoint and never borrows it for another id", () => {
    const kimiEntrypoint = paths.resolve(
      appData,
      "npm",
      "node_modules",
      "@moonshot-ai",
      "kimi-code",
      "dist",
      "main.mjs"
    );
    expect(
      resolveAgentCommand("kimi", "kimi", defaultCommand("kimi"), baseDirectory, windowsDependencies([nodeExecutable, kimiEntrypoint]))
    ).toEqual({ executable: nodeExecutable, prefixArgs: [kimiEntrypoint] });
  });
});
