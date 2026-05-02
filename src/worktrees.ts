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
