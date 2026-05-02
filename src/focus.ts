import * as vscode from "vscode";

type FolderEntry = { uri: vscode.Uri; name: string };

export function focusOn(entries: FolderEntry[]): boolean {
    if (entries.length === 0) {return false;}
    const folders = vscode.workspace.workspaceFolders ?? [];
    return vscode.workspace.updateWorkspaceFolders(0, folders.length, ...entries);
}
