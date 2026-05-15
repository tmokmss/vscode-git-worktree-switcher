import { describe, expect, it } from "vitest";
import type { Worktree } from "../src/git";
import {
    buildFocusEntries,
    buildMultiRepoShowAllEntries,
    buildRepoFocusSwap,
    buildRootsOnlyEntries,
    buildShowAllEntries,
    dedupeByPath,
    determineRoot,
    planWorkspaceRecovery,
    shouldDescendInto,
    worktreeLabel,
    type ExistingFolder,
    type RecoveryFolder,
    type RepoSnapshot,
} from "../src/worktrees";

const wt = (overrides: Partial<Worktree>): Worktree => ({
    path: "/repo/main",
    head: "abc",
    branch: "main",
    bare: false,
    detached: false,
    ...overrides,
});

describe("worktreeLabel", () => {
    it("uses branch name when present", () => {
        expect(worktreeLabel(wt({ branch: "feature-a" }))).toBe("feature-a");
    });

    it("falls back to basename when branch is null and not detached", () => {
        expect(worktreeLabel(wt({ path: "/repo/standalone", branch: null }))).toBe("standalone");
    });

    it("marks bare repos", () => {
        expect(worktreeLabel(wt({ path: "/repo/.bare", branch: null, bare: true }))).toBe(".bare (bare)");
    });

    it("marks detached worktrees", () => {
        expect(worktreeLabel(wt({ path: "/repo/dt", branch: null, detached: true }))).toBe("dt (detached)");
    });
});

describe("determineRoot", () => {
    it("returns the first non-bare worktree", () => {
        const list = [
            wt({ path: "/repo/.bare", branch: null, bare: true }),
            wt({ path: "/repo/main", branch: "main" }),
            wt({ path: "/repo/feature", branch: "feature" }),
        ];
        expect(determineRoot(list)).toEqual({ path: "/repo/main", label: "main" });
    });

    it("returns null when only bare repos exist", () => {
        expect(determineRoot([wt({ path: "/repo/.bare", branch: null, bare: true })])).toBeNull();
    });

    it("returns null for empty list", () => {
        expect(determineRoot([])).toBeNull();
    });

    it("uses the first non-bare even when its branch is unconventional", () => {
        const list = [wt({ path: "/repo/feat-x", branch: "feat-x" })];
        expect(determineRoot(list)).toEqual({ path: "/repo/feat-x", label: "feat-x" });
    });
});

describe("dedupeByPath", () => {
    it("removes later entries with the same path", () => {
        const out = dedupeByPath([
            { path: "/a", label: "first" },
            { path: "/b", label: "second" },
            { path: "/a", label: "duplicate" },
        ]);
        expect(out).toEqual([
            { path: "/a", label: "first" },
            { path: "/b", label: "second" },
        ]);
    });

    it("returns empty for empty input", () => {
        expect(dedupeByPath([])).toEqual([]);
    });
});

describe("buildFocusEntries", () => {
    const list: Worktree[] = [
        wt({ path: "/repo/main", branch: "main" }),
        wt({ path: "/repo/feature-a", branch: "feature-a" }),
        wt({ path: "/repo/feature-b", branch: "feature-b" }),
    ];

    it("includes root + focused worktree when they differ", () => {
        expect(buildFocusEntries(list, "/repo/feature-a")).toEqual([
            { path: "/repo/main", label: "main" },
            { path: "/repo/feature-a", label: "feature-a" },
        ]);
    });

    it("returns just root when focused == root (no duplicate)", () => {
        expect(buildFocusEntries(list, "/repo/main")).toEqual([
            { path: "/repo/main", label: "main" },
        ]);
    });

    it("returns empty when focused path is not in worktree list", () => {
        expect(buildFocusEntries(list, "/repo/does-not-exist")).toEqual([]);
    });

    it("works in bare-repo setup with no main branch worktree", () => {
        const bareList: Worktree[] = [
            wt({ path: "/repo/.bare", branch: null, bare: true }),
            wt({ path: "/repo/feat-x", branch: "feat-x" }),
            wt({ path: "/repo/feat-y", branch: "feat-y" }),
        ];
        expect(buildFocusEntries(bareList, "/repo/feat-y")).toEqual([
            { path: "/repo/feat-x", label: "feat-x" },
            { path: "/repo/feat-y", label: "feat-y" },
        ]);
    });
});

describe("buildShowAllEntries", () => {
    it("includes root first, then all non-bare worktrees, deduped", () => {
        const list: Worktree[] = [
            wt({ path: "/repo/main", branch: "main" }),
            wt({ path: "/repo/feature-a", branch: "feature-a" }),
        ];
        expect(buildShowAllEntries(list)).toEqual([
            { path: "/repo/main", label: "main" },
            { path: "/repo/feature-a", label: "feature-a" },
        ]);
    });

    it("excludes bare entries", () => {
        const list: Worktree[] = [
            wt({ path: "/repo/.bare", branch: null, bare: true }),
            wt({ path: "/repo/main", branch: "main" }),
        ];
        expect(buildShowAllEntries(list)).toEqual([{ path: "/repo/main", label: "main" }]);
    });

    it("returns empty when only bare repos exist", () => {
        const list: Worktree[] = [wt({ path: "/repo/.bare", branch: null, bare: true })];
        expect(buildShowAllEntries(list)).toEqual([]);
    });
});

describe("shouldDescendInto", () => {
    it("skips hidden directories", () => {
        expect(shouldDescendInto(".git")).toBe(false);
        expect(shouldDescendInto(".vscode")).toBe(false);
        expect(shouldDescendInto(".cache")).toBe(false);
    });

    it("skips known heavy directories", () => {
        expect(shouldDescendInto("node_modules")).toBe(false);
        expect(shouldDescendInto("dist")).toBe(false);
        expect(shouldDescendInto("build")).toBe(false);
    });

    it("descends into normal directories", () => {
        expect(shouldDescendInto("repos")).toBe(true);
        expect(shouldDescendInto("repo1")).toBe(true);
        expect(shouldDescendInto("src")).toBe(true);
    });
});

describe("buildRootsOnlyEntries", () => {
    const repo1: RepoSnapshot = {
        commonDir: "/repo1/.git",
        name: "repo1",
        worktrees: [
            wt({ path: "/repo1/main", branch: "main" }),
            wt({ path: "/repo1/feat-a", branch: "feat-a" }),
        ],
    };
    const repo2: RepoSnapshot = {
        commonDir: "/repo2/.git",
        name: "repo2",
        worktrees: [
            wt({ path: "/repo2/main", branch: "main" }),
            wt({ path: "/repo2/feat-x", branch: "feat-x" }),
        ],
    };

    it("returns one root entry per repo with prefix when multi-repo", () => {
        expect(buildRootsOnlyEntries([repo1, repo2])).toEqual([
            { path: "/repo1/main", label: "repo1 / main" },
            { path: "/repo2/main", label: "repo2 / main" },
        ]);
    });

    it("does not prefix when only one repo", () => {
        expect(buildRootsOnlyEntries([repo1])).toEqual([
            { path: "/repo1/main", label: "main" },
        ]);
    });

    it("preserves non-git extra folders", () => {
        const extras: ExistingFolder[] = [
            { path: "/notes", name: "notes", commonDir: null },
            { path: "/repo1/main", name: "main", commonDir: repo1.commonDir },
        ];
        expect(buildRootsOnlyEntries([repo1], extras)).toEqual([
            { path: "/repo1/main", label: "main" },
            { path: "/notes", label: "notes" },
        ]);
    });

    it("skips bare-only repos (no main worktree to use as root)", () => {
        const bareOnly: RepoSnapshot = {
            commonDir: "/bareonly/.git",
            name: "bareonly",
            worktrees: [wt({ path: "/bareonly/.git", branch: null, bare: true })],
        };
        expect(buildRootsOnlyEntries([bareOnly])).toEqual([]);
    });
});

describe("buildRepoFocusSwap", () => {
    const repo1: RepoSnapshot = {
        commonDir: "/repo1/.git",
        name: "repo1",
        worktrees: [
            wt({ path: "/repo1/main", branch: "main" }),
            wt({ path: "/repo1/feat-a", branch: "feat-a" }),
            wt({ path: "/repo1/feat-b", branch: "feat-b" }),
        ],
    };
    const repo2: RepoSnapshot = {
        commonDir: "/repo2/.git",
        name: "repo2",
        worktrees: [
            wt({ path: "/repo2/main", branch: "main" }),
            wt({ path: "/repo2/feat-x", branch: "feat-x" }),
        ],
    };

    it("replaces focused repo's slot, keeps other repos untouched", () => {
        const current: ExistingFolder[] = [
            { path: "/repo1/main", name: "repo1 / main", commonDir: repo1.commonDir },
            { path: "/repo2/main", name: "repo2 / main", commonDir: repo2.commonDir },
        ];

        const result = buildRepoFocusSwap(current, [repo1, repo2], repo1, "/repo1/feat-b");

        expect(result).toEqual([
            { path: "/repo1/feat-b", label: "repo1 / feat-b" },
            { path: "/repo2/main", label: "repo2 / main" },
        ]);
    });

    it("appends focused worktree if its repo is not yet in workspace", () => {
        const current: ExistingFolder[] = [
            { path: "/repo2/main", name: "repo2 / main", commonDir: repo2.commonDir },
        ];

        const result = buildRepoFocusSwap(current, [repo1, repo2], repo1, "/repo1/feat-a");

        expect(result).toEqual([
            { path: "/repo2/main", label: "repo2 / main" },
            { path: "/repo1/feat-a", label: "repo1 / feat-a" },
        ]);
    });

    it("consolidates multiple folders of the same repo into the focused one", () => {
        const current: ExistingFolder[] = [
            { path: "/repo1/main", name: "repo1 / main", commonDir: repo1.commonDir },
            { path: "/repo1/feat-a", name: "repo1 / feat-a", commonDir: repo1.commonDir },
            { path: "/repo2/main", name: "repo2 / main", commonDir: repo2.commonDir },
        ];

        const result = buildRepoFocusSwap(current, [repo1, repo2], repo1, "/repo1/feat-b");

        expect(result).toEqual([
            { path: "/repo1/feat-b", label: "repo1 / feat-b" },
            { path: "/repo2/main", label: "repo2 / main" },
        ]);
    });

    it("does not prefix labels when only one repo is known", () => {
        const current: ExistingFolder[] = [
            { path: "/repo1/main", name: "main", commonDir: repo1.commonDir },
        ];

        const result = buildRepoFocusSwap(current, [repo1], repo1, "/repo1/feat-a");

        expect(result).toEqual([{ path: "/repo1/feat-a", label: "feat-a" }]);
    });

    it("returns current unchanged when focused worktree path is unknown", () => {
        const current: ExistingFolder[] = [
            { path: "/repo1/main", name: "main", commonDir: repo1.commonDir },
        ];

        const result = buildRepoFocusSwap(current, [repo1], repo1, "/repo1/does-not-exist");

        expect(result).toEqual([{ path: "/repo1/main", label: "main" }]);
    });
});

describe("buildMultiRepoShowAllEntries", () => {
    const repo1: RepoSnapshot = {
        commonDir: "/repo1/.git",
        name: "repo1",
        worktrees: [
            wt({ path: "/repo1/main", branch: "main" }),
            wt({ path: "/repo1/feat-a", branch: "feat-a" }),
        ],
    };
    const repo2: RepoSnapshot = {
        commonDir: "/repo2/.git",
        name: "repo2",
        worktrees: [
            wt({ path: "/repo2/main", branch: "main" }),
            wt({ path: "/repo2/feat-x", branch: "feat-x" }),
            wt({ path: "/repo2/feat-y", branch: "feat-y" }),
        ],
    };

    it("prefixes labels with repo name when multiple repos are present", () => {
        const current: ExistingFolder[] = [
            { path: "/repo1/main", name: "repo1 / main", commonDir: repo1.commonDir },
            { path: "/repo2/main", name: "repo2 / main", commonDir: repo2.commonDir },
        ];

        const result = buildMultiRepoShowAllEntries(current, [repo1, repo2]);

        expect(result).toEqual([
            { path: "/repo1/main", label: "repo1 / main" },
            { path: "/repo1/feat-a", label: "repo1 / feat-a" },
            { path: "/repo2/main", label: "repo2 / main" },
            { path: "/repo2/feat-x", label: "repo2 / feat-x" },
            { path: "/repo2/feat-y", label: "repo2 / feat-y" },
        ]);
    });

    it("does not prefix labels when only one repo is present", () => {
        const current: ExistingFolder[] = [
            { path: "/repo1/main", name: "main", commonDir: repo1.commonDir },
        ];

        const result = buildMultiRepoShowAllEntries(current, [repo1]);

        expect(result).toEqual([
            { path: "/repo1/main", label: "main" },
            { path: "/repo1/feat-a", label: "feat-a" },
        ]);
    });

    it("includes all discovered repos even if not currently in the workspace", () => {
        const current: ExistingFolder[] = [
            { path: "/repo1/main", name: "repo1 / main", commonDir: repo1.commonDir },
        ];

        const result = buildMultiRepoShowAllEntries(current, [repo1, repo2]);

        expect(result.map((e) => e.path)).toEqual([
            "/repo1/main",
            "/repo1/feat-a",
            "/repo2/main",
            "/repo2/feat-x",
            "/repo2/feat-y",
        ]);
    });

    it("orders currently-present repos first, then newly discovered ones", () => {
        const current: ExistingFolder[] = [
            { path: "/repo2/main", name: "repo2 / main", commonDir: repo2.commonDir },
        ];

        const result = buildMultiRepoShowAllEntries(current, [repo1, repo2]);

        expect(result.map((e) => e.path)).toEqual([
            "/repo2/main",
            "/repo2/feat-x",
            "/repo2/feat-y",
            "/repo1/main",
            "/repo1/feat-a",
        ]);
    });

    it("preserves unrelated (non-git) folders at the end", () => {
        const current: ExistingFolder[] = [
            { path: "/repo1/main", name: "main", commonDir: repo1.commonDir },
            { path: "/notes", name: "notes", commonDir: null },
        ];

        const result = buildMultiRepoShowAllEntries(current, [repo1]);

        expect(result.map((e) => e.path)).toEqual(["/repo1/main", "/repo1/feat-a", "/notes"]);
    });
});

describe("planWorkspaceRecovery", () => {
    const repo1: RepoSnapshot = {
        commonDir: "/repo1/.git",
        name: "repo1",
        worktrees: [
            wt({ path: "/repo1/main", branch: "main" }),
            wt({ path: "/repo1/feat-a", branch: "feat-a" }),
        ],
    };
    const repo2: RepoSnapshot = {
        commonDir: "/repo2/.git",
        name: "repo2",
        worktrees: [
            wt({ path: "/repo2/main", branch: "main" }),
            wt({ path: "/repo2/feat-x", branch: "feat-x" }),
        ],
    };

    const aliveAll = () => true;

    it("returns empty when every folder exists (no recovery needed)", () => {
        const folders: RecoveryFolder[] = [
            { path: "/repo1/main", name: "main", exists: true, commonDir: repo1.commonDir },
        ];
        const result = planWorkspaceRecovery({
            folders,
            survivingRepos: [repo1],
            cachedRepos: [repo1],
            isAlive: aliveAll,
        });
        expect(result).toEqual([]);
    });

    it("restores to repo root when the focused worktree path disappeared", () => {
        const folders: RecoveryFolder[] = [
            { path: "/repo1/feat-a", name: "feat-a", exists: false, commonDir: null },
        ];
        const result = planWorkspaceRecovery({
            folders,
            survivingRepos: [],
            cachedRepos: [repo1],
            isAlive: (p) => p === "/repo1/main",
        });
        expect(result).toEqual([{ path: "/repo1/main", label: "main" }]);
    });

    it("drops cached repos whose own main worktree is also gone", () => {
        const folders: RecoveryFolder[] = [
            { path: "/repo1/feat-a", name: "feat-a", exists: false, commonDir: null },
        ];
        const result = planWorkspaceRecovery({
            folders,
            survivingRepos: [],
            cachedRepos: [repo1],
            isAlive: () => false,
        });
        expect(result).toEqual([]);
    });

    it("prefers surviving discovery over cache for the same repo", () => {
        const renamed: RepoSnapshot = {
            commonDir: repo1.commonDir,
            name: "repo1-renamed",
            worktrees: [wt({ path: "/repo1/main", branch: "main" })],
        };
        const folders: RecoveryFolder[] = [
            { path: "/repo1/main", name: "main", exists: true, commonDir: repo1.commonDir },
            { path: "/repo1/feat-a", name: "feat-a", exists: false, commonDir: null },
        ];
        const result = planWorkspaceRecovery({
            folders,
            survivingRepos: [renamed],
            cachedRepos: [repo1],
            isAlive: aliveAll,
        });
        expect(result).toEqual([{ path: "/repo1/main", label: "main" }]);
    });

    it("dedupes survivingRepos passed in raw", () => {
        const folders: RecoveryFolder[] = [
            { path: "/repo1/feat-a", name: "feat-a", exists: false, commonDir: null },
        ];
        const result = planWorkspaceRecovery({
            folders,
            survivingRepos: [repo1, repo1],
            cachedRepos: [],
            isAlive: aliveAll,
        });
        expect(result).toEqual([{ path: "/repo1/main", label: "main" }]);
    });

    it("restores multi-repo roots when one repo's worktree dies", () => {
        const folders: RecoveryFolder[] = [
            { path: "/repo1/feat-a", name: "feat-a", exists: false, commonDir: null },
            { path: "/repo2/main", name: "repo2 / main", exists: true, commonDir: repo2.commonDir },
        ];
        const result = planWorkspaceRecovery({
            folders,
            survivingRepos: [repo2],
            cachedRepos: [repo1, repo2],
            isAlive: aliveAll,
        });
        expect(result).toEqual([
            { path: "/repo2/main", label: "repo2 / main" },
            { path: "/repo1/main", label: "repo1 / main" },
        ]);
    });

    it("preserves surviving non-git folders", () => {
        const folders: RecoveryFolder[] = [
            { path: "/repo1/feat-a", name: "feat-a", exists: false, commonDir: null },
            { path: "/notes", name: "notes", exists: true, commonDir: null },
        ];
        const result = planWorkspaceRecovery({
            folders,
            survivingRepos: [],
            cachedRepos: [repo1],
            isAlive: aliveAll,
        });
        expect(result).toEqual([
            { path: "/repo1/main", label: "main" },
            { path: "/notes", label: "notes" },
        ]);
    });

    it("returns empty when there is nothing to fall back to", () => {
        const folders: RecoveryFolder[] = [
            { path: "/repo1/feat-a", name: "feat-a", exists: false, commonDir: null },
        ];
        const result = planWorkspaceRecovery({
            folders,
            survivingRepos: [],
            cachedRepos: [],
            isAlive: aliveAll,
        });
        expect(result).toEqual([]);
    });
});
