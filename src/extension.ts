import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getGitCommonDir, getSuperprojectPath, listWorktrees, type Worktree } from "./git";
import { focusOn } from "./focus";
import {
    buildRepoFocusSwap,
    buildRootsOnlyEntries,
    planWorkspaceRecovery,
    repoDisplayName,
    shouldDescendInto,
    worktreeLabel,
    type ExistingFolder,
    type RecoveryFolder,
    type RepoSnapshot,
    type RootEntry,
} from "./worktrees";

const REPO_DISCOVERY_MAX_DEPTH = 2;
const CACHE_TTL_MS = 60_000;

let repoCache: { repos: RepoSnapshot[]; timestamp: number } | null = null;
let lastKnownRepos: RepoSnapshot[] = [];
let recovering = false;

let outputChannel: vscode.OutputChannel | null = null;
function log(msg: string): void {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("Worktrees");
    }
    const ts = new Date().toISOString().slice(11, 23);
    outputChannel.appendLine(`[${ts}] ${msg}`);
}

export function activate(context: vscode.ExtensionContext) {
    const cmd = (name: string, fn: () => Promise<void> | void) =>
        vscode.commands.registerCommand(name, async () => {
            await verifyAndRecoverWorkspace();
            await fn();
        });

    context.subscriptions.push(
        cmd("vscode-git-worktree-switcher.addWorktree", () => addWorktreeCommand()),
        cmd("vscode-git-worktree-switcher.focusWorktree", () => focusWorktreeCommand()),
        cmd("vscode-git-worktree-switcher.unfocusWorktree", () => unfocusWorktreeCommand()),
        cmd("vscode-git-worktree-switcher.removeWorktreeFolder", () => removeWorktreeFolderCommand()),
        cmd("vscode-git-worktree-switcher.refreshWorktrees", () => refreshCommand()),
        vscode.commands.registerCommand("vscode-git-worktree-switcher.showLogs", () => {
            if (!outputChannel) {outputChannel = vscode.window.createOutputChannel("Worktrees");}
            outputChannel.show();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            log(`Workspace folders changed → invalidating cache`);
            await verifyAndRecoverWorkspace();
            repoCache = null;
            void updateWindowTitle();
        }),
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                void verifyAndRecoverWorkspace();
            }
        })
    );

    setTimeout(async () => {
        try {
            await getRepos();
            await verifyAndRecoverWorkspace();
            await updateWindowTitle();
        } catch (e) {
            log(`Pre-warm failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }, 100);

    if (vscode.workspace.getConfiguration().get<boolean>("vscode-git-worktree-switcher.autoAddOnStartup", false)) {
        void unfocusWorktreeCommand(true);
    }
}

export function deactivate() {
    try {
        void vscode.workspace
            .getConfiguration("window")
            .update("title", undefined, vscode.ConfigurationTarget.Workspace);
    } catch {
        // best-effort cleanup
    }
}

async function updateWindowTitle(): Promise<void> {
    if (!vscode.workspace.getConfiguration().get<boolean>("vscode-git-worktree-switcher.overrideWindowTitle", true)) {
        return;
    }

    let rootName: string | null = null;
    try {
        const repos = await getRepos();
        if (repos.length > 0) {
            rootName = repos[0].name;
        }
    } catch (e) {
        log(`updateWindowTitle: getRepos failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!rootName) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {return;}
        rootName = path.basename(folders[0].uri.fsPath);
    }

    const safe = rootName.replace(/\$\{/g, "$ {");
    const title = `\${dirty}\${activeEditorShort}\${separator}${safe}\${separator}\${profileName}\${separator}\${appName}`;

    try {
        await vscode.workspace
            .getConfiguration("window")
            .update("title", title, vscode.ConfigurationTarget.Workspace);
        log(`Set window.title rootName="${rootName}"`);
    } catch (e) {
        log(`Failed to set window.title: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function pickAnchorFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        vscode.window.showErrorMessage("Open a folder first.");
        return undefined;
    }
    if (folders.length === 1) {return folders[0];}
    return vscode.window.showWorkspaceFolderPick({
        placeHolder: "Select a folder whose repository to query for worktrees",
    });
}

async function getCommonDirSafe(cwd: string): Promise<string | null> {
    try {
        return await getGitCommonDir(cwd);
    } catch {
        return null;
    }
}

async function getExistingFolders(): Promise<ExistingFolder[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const out: ExistingFolder[] = [];
    for (const f of folders) {
        const commonDir = await getCommonDirSafe(f.uri.fsPath);
        out.push({ path: f.uri.fsPath, name: f.name, commonDir });
    }
    return out;
}

async function getRepoSnapshot(cwd: string): Promise<RepoSnapshot | undefined> {
    try {
        const [commonDir, worktrees, superproject] = await Promise.all([
            getGitCommonDir(cwd),
            listWorktrees(cwd),
            getSuperprojectPath(cwd),
        ]);
        if (superproject) {
            log(`Skipping submodule at ${cwd} (superproject=${superproject})`);
            return undefined;
        }
        const realWorktrees = await filterRealWorktrees(worktrees);
        return {
            commonDir,
            name: repoDisplayName(commonDir, realWorktrees),
            worktrees: realWorktrees,
        };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`getRepoSnapshot failed at ${cwd}: ${msg}`);
        return undefined;
    }
}

async function filterRealWorktrees(worktrees: Worktree[]): Promise<Worktree[]> {
    const checks = await Promise.all(
        worktrees.map(async (w) => {
            if (w.bare) {return { w, keep: true };}
            const isInsideGitDir = w.path.includes("/.git/");
            const isWorking = await isGitWorkingDir(w.path);
            const keep = !isInsideGitDir && isWorking;
            if (!keep) {
                log(`Filtered out non-working-tree worktree: ${w.path} (isInsideGitDir=${isInsideGitDir}, isWorking=${isWorking})`);
            }
            return { w, keep };
        })
    );
    return checks.filter((c) => c.keep).map((c) => c.w);
}

async function isGitWorkingDir(p: string): Promise<boolean> {
    try {
        await fs.stat(path.join(p, ".git"));
        return true;
    } catch {
        return false;
    }
}

async function findNestedRepos(start: string, maxDepth: number): Promise<string[]> {
    const found: string[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 0 && (await isGitWorkingDir(dir))) {
            found.push(dir);
            return;
        }
        if (depth >= maxDepth) {return;}

        let entries: import("node:fs").Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (e: unknown) {
            log(`readdir failed: ${dir} (${e instanceof Error ? e.message : String(e)})`);
            return;
        }

        const subdirs = entries
            .filter((e) => e.isDirectory() && shouldDescendInto(e.name))
            .map((e) => path.join(dir, e.name));

        await Promise.all(subdirs.map((sub) => walk(sub, depth + 1)));
    };

    await walk(start, 0);
    return found;
}

async function getRepos(forceRefresh = false): Promise<RepoSnapshot[]> {
    if (!forceRefresh && repoCache && Date.now() - repoCache.timestamp < CACHE_TTL_MS) {
        log(`Cache hit (age=${Date.now() - repoCache.timestamp}ms, repos=${repoCache.repos.length})`);
        return repoCache.repos;
    }
    log(`Cache miss, running discovery`);
    const repos = await discoverReposFromWorkspace();
    repoCache = { repos, timestamp: Date.now() };
    if (repos.length > 0) {lastKnownRepos = repos;}
    return repos;
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.stat(p);
        return true;
    } catch {
        return false;
    }
}

async function verifyAndRecoverWorkspace(): Promise<void> {
    if (recovering) {return;}
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    if (wsFolders.length === 0) {return;}

    const folders: RecoveryFolder[] = await Promise.all(
        wsFolders.map(async (f) => {
            const exists = await pathExists(f.uri.fsPath);
            const commonDir = exists ? await getCommonDirSafe(f.uri.fsPath) : null;
            return { path: f.uri.fsPath, name: f.name, exists, commonDir };
        })
    );

    const missing = folders.filter((f) => !f.exists);
    if (missing.length === 0) {return;}

    recovering = true;
    try {
        log(`Recovery: missing workspace folders: ${missing.map((m) => m.path).join(", ")}`);

        const survivingSnaps = await Promise.all(
            folders.filter((f) => f.exists).map((f) => getRepoSnapshot(f.path))
        );
        const survivingRepos = survivingSnaps.filter((s): s is RepoSnapshot => !!s);

        const cachedMainPaths = [
            ...new Set(
                lastKnownRepos
                    .map((r) => r.worktrees.find((w) => !w.bare)?.path)
                    .filter((p): p is string => !!p)
            ),
        ];
        const aliveResults = await Promise.all(cachedMainPaths.map((p) => pathExists(p)));
        const cachedExistence = new Map(cachedMainPaths.map((p, i) => [p, aliveResults[i]]));

        const entries = planWorkspaceRecovery({
            folders,
            survivingRepos,
            cachedRepos: lastKnownRepos,
            isAlive: (p) => cachedExistence.get(p) ?? false,
        });

        if (entries.length === 0) {
            log(`Recovery: no usable entries; leaving workspace unchanged`);
            return;
        }

        const ok = focusOn(toFolderEntries(entries));
        if (ok) {
            log(`Recovery: restored ${entries.length} folder(s)`);
            vscode.window.showWarningMessage("Worktree folder no longer exists; restored to repository root.");
        } else {
            log(`Recovery: focusOn returned false`);
        }
    } finally {
        recovering = false;
    }
}

async function refreshCommand(): Promise<void> {
    repoCache = null;
    const t0 = Date.now();
    const repos = await getRepos(true);
    log(`Refresh: ${repos.length} repo(s) in ${Date.now() - t0}ms`);
    await unfocusWorktreeCommand(true);
    vscode.window.showInformationMessage(
        `Refreshed ${repos.length} repo(s) in ${Date.now() - t0}ms`
    );
}

async function discoverReposFromWorkspace(): Promise<RepoSnapshot[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const t0 = Date.now();
    log(`Discovery: scanning ${folders.length} workspace folder(s) (maxDepth=${REPO_DISCOVERY_MAX_DEPTH})`);

    const perFolder = await Promise.all(
        folders.map(async (f) => {
            const direct = getRepoSnapshot(f.uri.fsPath);
            const nested = findNestedRepos(f.uri.fsPath, REPO_DISCOVERY_MAX_DEPTH);
            const [directSnap, nestedPaths] = await Promise.all([direct, nested]);
            const nestedSnaps = await Promise.all(nestedPaths.map((p) => getRepoSnapshot(p)));
            return { directSnap, nestedSnaps };
        })
    );

    const seen = new Map<string, RepoSnapshot>();
    for (const { directSnap, nestedSnaps } of perFolder) {
        if (directSnap && !seen.has(directSnap.commonDir)) {seen.set(directSnap.commonDir, directSnap);}
        for (const snap of nestedSnaps) {
            if (snap && !seen.has(snap.commonDir)) {seen.set(snap.commonDir, snap);}
        }
    }

    log(`Discovery: total ${seen.size} unique repo(s) in ${Date.now() - t0}ms`);
    return [...seen.values()];
}

function toFolderEntries(entries: RootEntry[]): { uri: vscode.Uri; name: string }[] {
    return entries.map((e) => ({ uri: vscode.Uri.file(e.path), name: e.label }));
}

type WorktreePick = {
    label: string;
    description: string;
    repo: RepoSnapshot;
    worktree: Worktree;
};

function buildWorktreePickItems(repos: RepoSnapshot[]): WorktreePick[] {
    const showRepoPrefix = repos.length > 1;
    const items: WorktreePick[] = [];
    for (const repo of repos) {
        for (const w of repo.worktrees) {
            if (w.bare) {continue;}
            const branchLabel = worktreeLabel(w);
            items.push({
                label: showRepoPrefix ? `${repo.name} / ${branchLabel}` : branchLabel,
                description: w.path,
                repo,
                worktree: w,
            });
        }
    }
    return items;
}

function waitForWorkspaceFoldersChange(timeoutMs = 1000): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            disposable.dispose();
            resolve();
        }, timeoutMs);
        const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            clearTimeout(timer);
            disposable.dispose();
            resolve();
        });
    });
}

async function collapseExplorer(): Promise<void> {
    await new Promise((r) => setTimeout(r, 250));
    try {
        await vscode.commands.executeCommand("workbench.files.action.collapseExplorerFolders");
    } catch (e: unknown) {
        log(`Collapse explorer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function addWorktreeCommand(): Promise<void> {
    const anchor = await pickAnchorFolder();
    if (!anchor) {return;}

    const snap = await getRepoSnapshot(anchor.uri.fsPath);
    if (!snap) {return;}

    const existing = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    const candidates = snap.worktrees.filter((w) => !w.bare && !existing.has(w.path));
    if (candidates.length === 0) {
        vscode.window.showInformationMessage("All worktrees are already in this workspace.");
        return;
    }

    const picked = await vscode.window.showQuickPick(
        candidates.map((w) => ({
            label: worktreeLabel(w),
            description: w.path,
            worktree: w,
        })),
        { placeHolder: "Select a worktree to add to this workspace", matchOnDescription: true }
    );
    if (!picked) {return;}

    const w = picked.worktree;
    const end = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(end, 0, {
        uri: vscode.Uri.file(w.path),
        name: worktreeLabel(w),
    });
}

async function focusWorktreeCommand(): Promise<void> {
    const repos = await getRepos();
    if (repos.length === 0) {
        vscode.window.showErrorMessage("No git repositories found in this workspace.");
        return;
    }

    const items = buildWorktreePickItems(repos);
    if (items.length === 0) {
        vscode.window.showErrorMessage("No worktrees found.");
        return;
    }

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Focus on a worktree (other repos in this workspace are preserved)",
        matchOnDescription: true,
    });
    if (!picked) {return;}

    const current = await getExistingFolders();
    const entries = buildRepoFocusSwap(current, repos, picked.repo, picked.worktree.path);
    const changeAwaiter = waitForWorkspaceFoldersChange();
    const ok = focusOn(toFolderEntries(entries));
    if (ok) {
        await changeAwaiter;
        await collapseExplorer();
        vscode.window.showInformationMessage(`Focused: ${worktreeLabel(picked.worktree)}`);
    }
}

async function unfocusWorktreeCommand(silent = false): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        if (!silent) {vscode.window.showErrorMessage("Open a folder first.");}
        return;
    }

    const repos = await getRepos();
    if (repos.length === 0) {
        if (!silent) {vscode.window.showErrorMessage("No git repositories found in this workspace.");}
        return;
    }

    const current = await getExistingFolders();
    const entries = buildRootsOnlyEntries(repos, current);
    if (entries.length === 0) {return;}

    const changeAwaiter = waitForWorkspaceFoldersChange();
    const ok = focusOn(toFolderEntries(entries));
    if (ok) {
        await changeAwaiter;
        await collapseExplorer();
        if (!silent) {vscode.window.showInformationMessage("Reset to root worktree(s).");}
    }
}

async function removeWorktreeFolderCommand(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {return;}

    const picked = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { placeHolder: "Select a worktree folder to remove from this workspace (does not delete files)", matchOnDescription: true }
    );
    if (!picked) {return;}

    vscode.workspace.updateWorkspaceFolders(picked.folder.index, 1);
}
