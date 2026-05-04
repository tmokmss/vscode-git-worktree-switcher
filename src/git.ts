import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type Worktree = {
    path: string;
    head: string;
    branch: string | null;
    bare: boolean;
    detached: boolean;
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
