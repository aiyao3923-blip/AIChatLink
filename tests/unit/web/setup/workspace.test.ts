import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSetupWorkspaceApi,
  listWorkspaceDirectories,
  revealWorkspaceDirectory,
  type WorkspaceDependencies
} from "../../../../src/web/setup/workspace.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "aichatlink-workspace-"));
  directories.push(directory);
  return directory;
}

function dependencies(home: string, revealed: string[] = []): WorkspaceDependencies {
  return {
    platform: process.platform,
    home,
    cwd: home,
    reveal: (directory) => {
      revealed.push(directory);
    }
  };
}

describe("workspace directory listing", () => {
  it("lists only real directories and flags git repositories", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "repo", ".git"), { recursive: true });
    await mkdir(path.join(root, "plain"), { recursive: true });
    await mkdir(path.join(root, ".hidden"), { recursive: true });
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# hi", "utf8");

    const listing = await listWorkspaceDirectories(root, dependencies(root));

    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(path.dirname(root));
    expect(listing.entries.map((entry) => entry.name)).toEqual(["plain", "repo"]);
    expect(listing.entries.find((entry) => entry.name === "repo")?.isRepository).toBe(true);
    expect(listing.entries.find((entry) => entry.name === "plain")?.isRepository).toBe(false);
    expect(listing.truncated).toBe(false);
  });

  it("offers the home directory as a shortcut and returns no parent at the root", async () => {
    const home = await scratch();
    const listing = await listWorkspaceDirectories(home, dependencies(home));

    expect(listing.shortcuts[0]).toMatchObject({ path: home });
    const filesystemRoot = await listWorkspaceDirectories(path.parse(home).root, dependencies(home));
    expect(filesystemRoot.parent).toBeNull();
  });

  it("falls back to the configured cwd and rejects paths that are not directories", async () => {
    const root = await scratch();
    await writeFile(path.join(root, "file.txt"), "x", "utf8");

    const listing = await listWorkspaceDirectories(undefined, dependencies(root));
    expect(listing.path).toBe(root);

    await expect(
      listWorkspaceDirectories(path.join(root, "file.txt"), dependencies(root))
    ).rejects.toThrow(/not a readable directory/u);
    await expect(
      listWorkspaceDirectories(path.join(root, "missing"), dependencies(root))
    ).rejects.toThrow(/not a readable directory/u);
  });
});

describe("workspace reveal", () => {
  it("reveals an existing directory through the injected file manager", async () => {
    const root = await scratch();
    const revealed: string[] = [];

    const result = await revealWorkspaceDirectory(root, dependencies(root, revealed));

    expect(result).toEqual({ opened: true, path: root });
    expect(revealed).toEqual([root]);
  });

  it("refuses to reveal a path that is not a directory", async () => {
    const root = await scratch();
    const revealed: string[] = [];

    await expect(
      revealWorkspaceDirectory(path.join(root, "missing"), dependencies(root, revealed))
    ).rejects.toThrow(/not a directory/u);
    expect(revealed).toEqual([]);
  });

  it("exposes the same behaviour through the HTTP-facing api", async () => {
    const root = await scratch();
    const revealed: string[] = [];
    const api = createSetupWorkspaceApi(dependencies(root, revealed));
    const signal = new AbortController().signal;

    expect((await api.list(undefined, signal)).path).toBe(root);
    expect((await api.reveal(root, signal)).opened).toBe(true);
    expect(revealed).toEqual([root]);
  });
});
