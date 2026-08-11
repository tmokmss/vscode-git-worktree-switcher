import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type Worktree = {
    path: string;
    head: string;
    branch: string | null;
    bare: boolean;
    detached: boolean;
    /** Committer date of the HEAD commit, in unix seconds. Undefined when unknown. */
    committedAt?: number;
};

export async function getGitTopLevel(cwd: string): Promise<string> {
    const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
}

export async function getGitCommonDir(cwd: string): Promise<string> {
    const { stdout } = await execFileP(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd }
    );
    return stdout.trim();
}

export async function getSuperprojectPath(cwd: string): Promise<string> {
    try {
        const { stdout } = await execFileP(
            "git",
            ["rev-parse", "--show-superproject-working-tree"],
            { cwd }
        );
        return stdout.trim();
    } catch {
        return "";
    }
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
    const { stdout } = await execFileP("git", ["worktree", "list", "--porcelain"], { cwd });
    return parsePorcelain(stdout);
}

const NULL_SHA = /^0+$/;

/** Committer dates (unix seconds) for the given commits, keyed by full sha. */
export async function getCommitTimestamps(cwd: string, heads: string[]): Promise<Map<string, number>> {
    const shas = [...new Set(heads.filter((h) => h && !NULL_SHA.test(h)))];
    if (shas.length === 0) {return new Map();}
    const { stdout } = await execFileP("git", ["show", "-s", "--format=%H %ct", ...shas], { cwd });
    return parseCommitTimestamps(stdout);
}

export function parseCommitTimestamps(stdout: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const line of stdout.split("\n")) {
        const [sha, ts] = line.trim().split(/\s+/);
        if (!sha || ts === undefined) {continue;}
        const seconds = Number(ts);
        if (!Number.isFinite(seconds)) {continue;}
        out.set(sha, seconds);
    }
    return out;
}

export function parsePorcelain(stdout: string): Worktree[] {
    const blocks = stdout.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
    return blocks.map((block) => {
        const wt: Worktree = { path: "", head: "", branch: null, bare: false, detached: false };
        for (const line of block.split("\n")) {
            if (line.startsWith("worktree ")) {wt.path = line.slice("worktree ".length);}
            else if (line.startsWith("HEAD ")) {wt.head = line.slice("HEAD ".length);}
            else if (line.startsWith("branch ")) {wt.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");}
            else if (line === "bare") {wt.bare = true;}
            else if (line === "detached") {wt.detached = true;}
        }
        return wt;
    });
}
