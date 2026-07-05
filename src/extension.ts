import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";

type Settings = {
  projectRoot: string;
  runCommandTemplate: string;
  uploadInstallCommandTemplate: string;
  uploadReleaseCommandTemplate: string;
  arguments: ArgumentDefinition[];
};

let extensionTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext): void {
  warnAboutLegacySettings();

  context.subscriptions.push(
    vscode.commands.registerCommand("mlTorrent.run", runRunFlow),
    vscode.commands.registerCommand("mlTorrent.upload", runUploadFlow),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === extensionTerminal) {
        extensionTerminal = undefined;
      }
    })
  );

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

function warnAboutLegacySettings(): void {
  const legacyValue = vscode.workspace.getConfiguration("mlTorrent").get("variableDefaults");
  if (legacyValue === undefined) {
    return;
  }

  void vscode.window.showWarningMessage(
    "ML-Torrent: `mlTorrent.variableDefaults` is deprecated and ignored. Keep defaults only in `mlTorrent.arguments`."
  );
}

async function runRunFlow(): Promise<void> {
  const project = await loadProjectContext();
  if (!project) {
    return;
  }

  const command = await resolveCommandTemplate(
    "ML-Torrent Run",
    project.settings.runCommandTemplate,
    project.settings.arguments,
    {
      peers: async (argument) => promptPeerCount(argument?.defaultValue)
    }
  );
  if (!command) {
    return;
  }

  executeInTerminal(project.projectRoot, command.trim(), "Run");
}

async function runUploadFlow(): Promise<void> {
  const project = await loadProjectContext();
  if (!project) {
    return;
  }

  const uploadActionArgument =
    findArgument(project.settings.arguments, "uploadAction")
    ?? findArgument(project.settings.arguments, "uploadMode");
  const action = await promptGenericPlaceholder(
    "ML-Torrent Upload",
    uploadActionArgument?.name ?? "uploadAction",
    uploadActionArgument?.defaultValue,
    uploadActionArgument?.choices
  );

  if (!action) {
    return;
  }

  if (action === "install") {
    const command = await resolveCommandTemplate(
      "ML-Torrent Upload",
      project.settings.uploadInstallCommandTemplate,
      project.settings.arguments
    );
    if (!command) {
      return;
    }

    executeInTerminal(project.projectRoot, command, "Upload: install");
    return;
  }

  const command = await resolveCommandTemplate(
    "ML-Torrent Upload",
    project.settings.uploadReleaseCommandTemplate,
    project.settings.arguments,
    {
      releaseNotes: async (argument) => {
        const releaseNotes = await promptReleaseNotes(argument?.defaultValue);
        if (releaseNotes === undefined) {
          return undefined;
        }
        return formatArgumentValue(argument, releaseNotes);
      }
    }
  );
  if (!command) {
    return;
  }

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
    runCommandTemplate: config.get<string>("runCommandTemplate", "./run.sh ${peers} ${backend}"),
    uploadInstallCommandTemplate: config.get<string>(
      "uploadInstallCommandTemplate",
      "cd \"gui/ML-Torrent App\" && ./mobile-app.sh install"
    ),
    uploadReleaseCommandTemplate: config.get<string>(
      "uploadReleaseCommandTemplate",
      "cd \"gui/ML-Torrent App\" && ./release.sh ${releaseNotes}"
    ),
    arguments: normalizeArguments(config.get<ArgumentDefinition[]>("arguments", [
      { name: "peers", prefix: "", defaultValue: "2" },
      { name: "backend", prefix: "--", defaultValue: "gpu", choices: ["none", "cpu", "gpu"] },
      { name: "releaseNotes", prefix: "", defaultValue: "Test build" },
      { name: "uploadAction", prefix: "", defaultValue: "install", choices: ["install", "upload"] }
    ]))
  };
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

async function resolveCommandTemplate(
  title: string,
  template: string,
  argumentsList: ArgumentDefinition[],
  resolvers: Record<string, PlaceholderResolver> = {}
): Promise<string | undefined> {
  const placeholders = extractPlaceholders(template);
  const values: Record<string, string> = {};

  for (const name of placeholders) {
    const argument = findArgument(argumentsList, name);
    const resolver = resolvers[name];
    if (resolver) {
      const resolved = await resolver(argument);
      if (resolved === undefined) {
        return undefined;
      }
      values[name] = resolved;
      continue;
    }

    const resolved = await promptGenericPlaceholder(title, name, argument?.defaultValue, argument?.choices);
    if (resolved === undefined) {
      return undefined;
    }
    values[name] = formatArgumentValue(argument, resolved);
  }

  return interpolate(template, values);
}

function extractPlaceholders(template: string): string[] {
  const found = template.matchAll(/\$\{(\w+)\}/g);
  const placeholders = new Set<string>();

  for (const match of found) {
    placeholders.add(match[1]);
  }

  return [...placeholders];
}

async function promptPeerCount(defaultValue: string | undefined): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: "Peers",
    placeHolder: "0-100",
    title: "ML-Torrent Run",
    value: defaultValue,
    validateInput: (value) => validatePeerCount(value)
  });
}

async function promptReleaseNotes(defaultValue: string | undefined): Promise<string | undefined> {
  const releaseNotes = await vscode.window.showInputBox({
    prompt: "Release notes",
    title: "ML-Torrent Upload",
    value: defaultValue,
    validateInput: (value) => value.trim().length > 0 ? undefined : "Release notes are required."
  });

  return releaseNotes?.trim();
}

async function promptGenericPlaceholder(
  title: string,
  placeholder: string,
  defaultValue: string | undefined,
  choices: string[] | undefined
): Promise<string | undefined> {
  if (choices && choices.length > 0) {
    const items = prioritizeDefaultValue(choices, defaultValue).map((choice) => ({
      label: choice,
      description: choice === defaultValue ? "default" : undefined
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: formatArgumentLabel(placeholder)
    });

    return selected?.label;
  }

  return vscode.window.showInputBox({
    title,
    prompt: formatArgumentLabel(placeholder),
    placeHolder: formatArgumentLabel(placeholder),
    value: defaultValue
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

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function prioritizeDefaultValue(values: string[], defaultValue: string | undefined): string[] {
  if (!defaultValue) {
    return values;
  }

  const index = values.indexOf(defaultValue);
  if (index === -1) {
    return values;
  }

  return [values[index], ...values.slice(0, index), ...values.slice(index + 1)];
}

function prioritizeDefaultOption<T extends { value: string }>(
  values: T[],
  defaultValue: string | undefined
): T[] {
  if (!defaultValue) {
    return values;
  }

  const index = values.findIndex((value) => value.value === defaultValue);
  if (index === -1) {
    return values;
  }

  return [values[index], ...values.slice(0, index), ...values.slice(index + 1)];
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

function normalizeArguments(values: ArgumentDefinition[]): ArgumentDefinition[] {
  return values
    .filter((value) => typeof value?.name === "string" && value.name.trim().length > 0)
    .map((value) => ({
      name: value.name.trim(),
      prefix: value.prefix ?? "",
      defaultValue: value.defaultValue ?? "",
      choices: Array.isArray(value.choices)
        ? value.choices.filter((choice): choice is string => typeof choice === "string")
        : undefined
    }));
}

function findArgument(values: ArgumentDefinition[], name: string): ArgumentDefinition | undefined {
  return values.find((value) => value.name === name);
}

function formatArgumentValue(argument: ArgumentDefinition | undefined, rawValue: string): string {
  const escapedValue = shellEscape(rawValue);
  const prefix = argument?.prefix ?? "";

  if (!prefix) {
    return escapedValue;
  }

  if (prefix.endsWith("=")) {
    return `${prefix}${escapedValue}`;
  }

  if (prefix === "-" || prefix === "--") {
    return `${prefix}${rawValue}`;
  }

  return `${prefix} ${escapedValue}`;
}

function formatArgumentLabel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
}

type PlaceholderResolver = (argument: ArgumentDefinition | undefined) => Promise<string | undefined>;

type ArgumentDefinition = {
  name: string;
  prefix?: string;
  defaultValue?: string;
  choices?: string[];
};
