import * as path from "node:path";
import type { Worktree } from "./git";

export type RootEntry = { path: string; label: string };

export function worktreeLabel(w: Worktree): string {
    if (w.bare) {return `${path.basename(w.path)} (bare)`;}
    if (w.detached) {return `${path.basename(w.path)} (detached)`;}
    return w.branch ?? path.basename(w.path);
}

export function repoDisplayName(commonDir: string, worktrees: Worktree[]): string {
    const main = worktrees.find((w) => !w.bare);
    if (main) {return path.basename(main.path);}
    const parent = path.dirname(commonDir);
    return path.basename(parent) || "repo";
}

function withPrefix(prefix: string | undefined, label: string): string {
    return prefix ? `${prefix} / ${label}` : label;
}

export function determineRoot(worktrees: Worktree[], repoName?: string): RootEntry | null {
    const main = worktrees.find((w) => !w.bare);
    if (!main) {return null;}
    return { path: main.path, label: withPrefix(repoName, worktreeLabel(main)) };
}

export function dedupeByPath<T extends { path: string }>(entries: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const e of entries) {
        if (seen.has(e.path)) {continue;}
        seen.add(e.path);
        out.push(e);
    }
    return out;
}

export function buildFocusEntries(
    worktrees: Worktree[],
    focusedWorktreePath: string,
    repoName?: string
): RootEntry[] {
    const focused = worktrees.find((w) => w.path === focusedWorktreePath);
    if (!focused) {return [];}
    const root = determineRoot(worktrees, repoName);
    const focusedEntry: RootEntry = {
        path: focused.path,
        label: withPrefix(repoName, worktreeLabel(focused)),
    };
    return root ? dedupeByPath([root, focusedEntry]) : [focusedEntry];
}

export function buildShowAllEntries(worktrees: Worktree[], repoName?: string): RootEntry[] {
    const root = determineRoot(worktrees, repoName);
    const all: RootEntry[] = worktrees
        .filter((w) => !w.bare)
        .map((w) => ({ path: w.path, label: withPrefix(repoName, worktreeLabel(w)) }));
    return root ? dedupeByPath([root, ...all]) : all;
}

const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "tmp",
    "coverage",
    ".next",
    ".cache",
]);

export function shouldDescendInto(dirName: string): boolean {
    if (dirName.startsWith(".")) {return false;}
    if (SKIP_DIRS.has(dirName)) {return false;}
    return true;
}

export type ExistingFolder = { path: string; name: string; commonDir: string | null };
export type RepoSnapshot = { commonDir: string; name: string; worktrees: Worktree[] };

export function buildMultiRepoShowAllEntries(
    current: ExistingFolder[],
    repos: RepoSnapshot[]
): RootEntry[] {
    const ordered = orderReposByFirstAppearance(repos, current);
    const showPrefix = ordered.length > 1;

    const out: RootEntry[] = [];
    for (const repo of ordered) {
        out.push(...buildShowAllEntries(repo.worktrees, showPrefix ? repo.name : undefined));
    }

    for (const f of current) {
        if (f.commonDir === null) {
            out.push({ path: f.path, label: f.name });
        }
    }

    return dedupeByPath(out);
}

export function buildRootsOnlyEntries(
    repos: RepoSnapshot[],
    extraFolders: ExistingFolder[] = []
): RootEntry[] {
    const showPrefix = repos.length > 1;
    const out: RootEntry[] = [];

    for (const repo of repos) {
        const root = determineRoot(repo.worktrees, showPrefix ? repo.name : undefined);
        if (root) {out.push(root);}
    }

    for (const f of extraFolders) {
        if (f.commonDir === null) {
            out.push({ path: f.path, label: f.name });
        }
    }

    return dedupeByPath(out);
}

export function buildRepoFocusSwap(
    current: ExistingFolder[],
    repos: RepoSnapshot[],
    focusedRepo: RepoSnapshot,
    focusedWorktreePath: string
): RootEntry[] {
    const showPrefix = repos.length > 1;
    const focused = focusedRepo.worktrees.find((w) => w.path === focusedWorktreePath);
    if (!focused) {
        return current.map((f) => ({ path: f.path, label: f.name }));
    }

    const focusedEntry: RootEntry = {
        path: focused.path,
        label: withPrefix(showPrefix ? focusedRepo.name : undefined, worktreeLabel(focused)),
    };

    const hasRepoInWorkspace = current.some((f) => f.commonDir === focusedRepo.commonDir);

    if (!hasRepoInWorkspace) {
        return dedupeByPath([
            ...current.map((f) => ({ path: f.path, label: f.name })),
            focusedEntry,
        ]);
    }

    const out: RootEntry[] = [];
    let inserted = false;
    for (const f of current) {
        if (f.commonDir === focusedRepo.commonDir) {
            if (!inserted) {
                out.push(focusedEntry);
                inserted = true;
            }
        } else {
            out.push({ path: f.path, label: f.name });
        }
    }
    return dedupeByPath(out);
}

export type RecoveryFolder = {
    path: string;
    name: string;
    exists: boolean;
    commonDir: string | null;
};

export function planWorkspaceRecovery(input: {
    folders: RecoveryFolder[];
    survivingRepos: RepoSnapshot[];
    cachedRepos: RepoSnapshot[];
    isAlive: (p: string) => boolean;
}): RootEntry[] {
    if (input.folders.every((f) => f.exists)) {return [];}

    const repos: RepoSnapshot[] = [];
    const seen = new Set<string>();
    for (const r of input.survivingRepos) {
        if (seen.has(r.commonDir)) {continue;}
        seen.add(r.commonDir);
        repos.push(r);
    }
    for (const r of input.cachedRepos) {
        if (seen.has(r.commonDir)) {continue;}
        const main = r.worktrees.find((w) => !w.bare);
        if (main && input.isAlive(main.path)) {
            seen.add(r.commonDir);
            repos.push(r);
        }
    }

    const survivors: ExistingFolder[] = input.folders
        .filter((f) => f.exists)
        .map((f) => ({ path: f.path, name: f.name, commonDir: f.commonDir }));

    return buildRootsOnlyEntries(repos, survivors);
}

function orderReposByFirstAppearance(
    repos: RepoSnapshot[],
    current: ExistingFolder[]
): RepoSnapshot[] {
    const repoByDir = new Map(repos.map((r) => [r.commonDir, r]));
    const ordered: RepoSnapshot[] = [];
    const used = new Set<string>();

    for (const f of current) {
        if (!f.commonDir) {continue;}
        if (used.has(f.commonDir)) {continue;}
        const repo = repoByDir.get(f.commonDir);
        if (!repo) {continue;}
        used.add(f.commonDir);
        ordered.push(repo);
    }

    for (const r of repos) {
        if (used.has(r.commonDir)) {continue;}
        ordered.push(r);
    }

    return ordered;
}
