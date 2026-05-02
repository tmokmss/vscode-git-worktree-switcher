import { describe, expect, it } from "vitest";
import { parsePorcelain } from "../src/git";

describe("parsePorcelain", () => {
    it("parses a regular repo with main + linked worktrees", () => {
        const stdout = [
            "worktree /repo/main",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /repo/feature-a",
            "HEAD def456",
            "branch refs/heads/feature-a",
            "",
        ].join("\n");

        expect(parsePorcelain(stdout)).toEqual([
            { path: "/repo/main", head: "abc123", branch: "main", bare: false, detached: false },
            { path: "/repo/feature-a", head: "def456", branch: "feature-a", bare: false, detached: false },
        ]);
    });

    it("parses a bare repo entry", () => {
        const stdout = [
            "worktree /repo/.bare",
            "bare",
            "",
            "worktree /repo/main",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
        ].join("\n");

        const result = parsePorcelain(stdout);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ path: "/repo/.bare", bare: true });
        expect(result[1]).toMatchObject({ path: "/repo/main", branch: "main", bare: false });
    });

    it("parses a detached HEAD worktree", () => {
        const stdout = ["worktree /repo/detached", "HEAD deadbeef", "detached", ""].join("\n");

        expect(parsePorcelain(stdout)).toEqual([
            { path: "/repo/detached", head: "deadbeef", branch: null, bare: false, detached: true },
        ]);
    });

    it("strips refs/heads/ prefix from branch names", () => {
        const stdout = ["worktree /repo/x", "HEAD aaa", "branch refs/heads/feat/nested-name", ""].join(
            "\n"
        );

        expect(parsePorcelain(stdout)[0].branch).toBe("feat/nested-name");
    });

    it("returns empty array for empty input", () => {
        expect(parsePorcelain("")).toEqual([]);
    });

    it("tolerates trailing whitespace and extra blank lines", () => {
        const stdout =
            "worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n\n\nworktree /repo/x\nHEAD def\nbranch refs/heads/x\n\n";
        expect(parsePorcelain(stdout)).toHaveLength(2);
    });
});
