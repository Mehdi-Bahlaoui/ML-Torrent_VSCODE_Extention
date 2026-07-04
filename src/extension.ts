import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";

type BackendChoice = "none" | "cpu" | "gpu";

type Settings = {
  projectRoot: string;
  checkCommandTemplate: string;
  runCommandTemplate: string;
  uploadInstallCommandTemplate: string;
  uploadReleaseCommandTemplate: string;
};

let extensionTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("mlTorrent.check", runCheckFlow),
    vscode.commands.registerCommand("mlTorrent.run", runRunFlow),
    vscode.commands.registerCommand("mlTorrent.upload", runUploadFlow),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === extensionTerminal) {
        extensionTerminal = undefined;
      }
    })
  );

  const statusBarItems = [
    createStatusBarItem("$(check) Check", "mlTorrent.check", 103),
    createStatusBarItem("$(play) Run", "mlTorrent.run", 102),
    createStatusBarItem("$(cloud-upload) Upload", "mlTorrent.upload", 101)
  ];

  for (const item of statusBarItems) {
    context.subscriptions.push(item);
    item.show();
  }

  context.subscriptions.push({
    dispose: () => {
      extensionTerminal?.dispose();
      extensionTerminal = undefined;
    }
  });
}

export function deactivate(): void {
  extensionTerminal?.dispose();
  extensionTerminal = undefined;
}

function createStatusBarItem(
  text: string,
  command: string,
  priority: number
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  item.text = text;
  item.command = command;
  item.name = `ML-Torrent ${text}`;
  return item;
}

async function runCheckFlow(): Promise<void> {
  const project = await loadProjectContext();
  if (!project) {
    return;
  }

  const crates = await getWorkspaceCrates(project.projectRoot);
  if (crates.length === 0) {
    void vscode.window.showErrorMessage("No Cargo workspace crates were found in the configured project root.");
    return;
  }

  const crate = await vscode.window.showQuickPick(crates, {
    placeHolder: "Select the crate to check",
    title: "ML-Torrent Check"
  });

  if (!crate) {
    return;
  }

  const command = interpolate(project.settings.checkCommandTemplate, {
    crate: shellEscape(crate)
  });

  executeInTerminal(project.projectRoot, command, `Check: ${crate}`);
}

async function runRunFlow(): Promise<void> {
  const project = await loadProjectContext();
  if (!project) {
    return;
  }

  const peersInput = await vscode.window.showInputBox({
    prompt: "How many peers should run in the network?",
    placeHolder: "0-100",
    title: "ML-Torrent Run",
    validateInput: (value) => validatePeerCount(value)
  });

  if (peersInput === undefined) {
    return;
  }

  const backend = await vscode.window.showQuickPick<{
    label: string;
    value: BackendChoice;
    description: string;
  }>(
    [
      { label: "none", value: "none", description: "Maps to -t for simulated training" },
      { label: "cpu", value: "cpu", description: "Maps to --cpu" },
      { label: "gpu", value: "gpu", description: "Maps to --gpu" }
    ],
    {
      placeHolder: "Select the backend mode",
      title: "ML-Torrent Run"
    }
  );

  if (!backend) {
    return;
  }

  const command = interpolate(project.settings.runCommandTemplate, {
    peers: peersInput,
    backendFlag: backendFlagFor(backend.value)
  });

  executeInTerminal(project.projectRoot, command.trim(), `Run: ${peersInput} peers, ${backend.value}`);
}

async function runUploadFlow(): Promise<void> {
  const project = await loadProjectContext();
  if (!project) {
    return;
  }

  const action = await vscode.window.showQuickPick<
    { label: string; value: "install" | "upload"; description: string }
  >(
    [
      { label: "install", value: "install", description: "Build and install on a connected mobile device" },
      { label: "upload", value: "upload", description: "Build and publish an OTA release" }
    ],
    {
      placeHolder: "Select the upload action",
      title: "ML-Torrent Upload"
    }
  );

  if (!action) {
    return;
  }

  if (action.value === "install") {
    executeInTerminal(
      project.projectRoot,
      project.settings.uploadInstallCommandTemplate,
      "Upload: install"
    );
    return;
  }

  const releaseNotes = await vscode.window.showInputBox({
    prompt: "Release notes / commit message for the uploaded build",
    title: "ML-Torrent Upload",
    validateInput: (value) => value.trim().length > 0 ? undefined : "Release notes are required."
  });

  if (releaseNotes === undefined) {
    return;
  }

  const command = interpolate(project.settings.uploadReleaseCommandTemplate, {
    releaseNotes: shellEscape(releaseNotes.trim())
  });

  executeInTerminal(project.projectRoot, command, "Upload: publish");
}

async function loadProjectContext(): Promise<{ workspaceFolder: vscode.WorkspaceFolder; projectRoot: string; settings: Settings } | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage("Open a workspace folder before using ML-Torrent Tools.");
    return undefined;
  }

  const settings = readSettings();
  const projectRoot = path.isAbsolute(settings.projectRoot)
    ? settings.projectRoot
    : path.resolve(workspaceFolder.uri.fsPath, settings.projectRoot);

  try {
    const stats = await fs.stat(projectRoot);
    if (!stats.isDirectory()) {
      throw new Error("Configured project root is not a directory.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`ML-Torrent project root is invalid: ${projectRoot}. ${message}`);
    return undefined;
  }

  return { workspaceFolder, projectRoot, settings };
}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration("mlTorrent");
  return {
    projectRoot: config.get<string>("projectRoot", "../dfl"),
    checkCommandTemplate: config.get<string>("checkCommandTemplate", "cargo check -p ${crate}"),
    runCommandTemplate: config.get<string>("runCommandTemplate", "./run.sh ${peers} ${backendFlag}"),
    uploadInstallCommandTemplate: config.get<string>(
      "uploadInstallCommandTemplate",
      "cd \"gui/ML-Torrent App\" && ./mobile-app.sh install"
    ),
    uploadReleaseCommandTemplate: config.get<string>(
      "uploadReleaseCommandTemplate",
      "cd \"gui/ML-Torrent App\" && ./release.sh ${releaseNotes}"
    )
  };
}

async function getWorkspaceCrates(projectRoot: string): Promise<string[]> {
  const metadata = await execJson<CargoMetadata>(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    projectRoot
  ).catch((error: Error) => {
    void vscode.window.showErrorMessage(`Failed to load Cargo workspace metadata: ${error.message}`);
    return undefined;
  });

  if (!metadata) {
    return [];
  }

  const rootPrefix = ensureTrailingSeparator(path.resolve(projectRoot));
  return metadata.packages
    .filter((pkg) => metadata.workspace_members.includes(pkg.id))
    .filter((pkg) => normalizeForCompare(pkg.manifest_path).startsWith(normalizeForCompare(rootPrefix)))
    .map((pkg) => pkg.name)
    .sort((left, right) => left.localeCompare(right));
}

function ensureTrailingSeparator(input: string): string {
  return input.endsWith(path.sep) ? input : `${input}${path.sep}`;
}

function normalizeForCompare(input: string): string {
  return process.platform === "win32" ? input.toLowerCase() : input;
}

function execJson<T>(command: string, args: string[], cwd: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(detail));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as T);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function executeInTerminal(cwd: string, command: string, detail: string): void {
  const terminal = getOrCreateTerminal(cwd);
  terminal.sendText(`cd ${shellEscape(cwd)}`, true);
  terminal.sendText(command, true);
  void vscode.window.showInformationMessage(`ML-Torrent started: ${detail}`);
}

function getOrCreateTerminal(cwd: string): vscode.Terminal {
  if (extensionTerminal && !extensionTerminal.exitStatus) {
    return extensionTerminal;
  }

  extensionTerminal = vscode.window.createTerminal({
    name: "ML-Torrent",
    cwd,
    isTransient: false
  });

  return extensionTerminal;
}

function validatePeerCount(value: string): string | undefined {
  if (!/^\d+$/.test(value.trim())) {
    return "Enter an integer between 0 and 100.";
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < 0 || parsed > 100) {
    return "Enter an integer between 0 and 100.";
  }

  return undefined;
}

function backendFlagFor(choice: BackendChoice): string {
  switch (choice) {
    case "none":
      return "-t";
    case "cpu":
      return "--cpu";
    case "gpu":
      return "--gpu";
  }
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function shellEscape(value: string): string {
  if (value.length === 0) {
    return "''";
  }

  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type CargoMetadata = {
  packages: Array<{
    id: string;
    name: string;
    manifest_path: string;
  }>;
  workspace_members: string[];
};
