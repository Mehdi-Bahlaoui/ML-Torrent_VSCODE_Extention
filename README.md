# ML-Torrent Tools

VS Code extension that adds `Run` and `Upload` actions to the editor title area for an ML-Torrent-style workspace.

## Why This Is Not On The Marketplace

This extension is intentionally kept as a local/private tool instead of a public VS Code Marketplace extension.

The reason is structural: it is designed around project-specific shell commands for one workspace, including build, run, install, and upload flows. In practice, that makes it more like an internal automation tool than a general-purpose VS Code extension.

Because it executes configurable local commands and exposes project-specific release actions, it is a poor fit for public Marketplace distribution. It is more reliable and more honest to distribute it locally as source code or as a private `.vsix`.


## Features

- `Run` prompts for peer count and backend mode, then runs the configured launch command.
- `Upload` prompts for either install or upload, and requests release notes for upload.
- Actions are contributed to the editor title area, which is the closest supported top-chrome placement for custom extension commands.
- Commands run in a reusable integrated terminal named `ML-Torrent` so the process stays available in the terminal panel.

## Default configuration

```json
{
  "mlTorrent.projectRoot": "../dfl",
  "mlTorrent.runCommandTemplate": "./run.sh ${peers} ${backend}",
  "mlTorrent.uploadInstallCommandTemplate": "cd \"gui/ML-Torrent App\" && ./mobile-app.sh install",
  "mlTorrent.uploadReleaseCommandTemplate": "cd \"gui/ML-Torrent App\" && ./release.sh ${releaseNotes}",
  "mlTorrent.arguments": [
    { "name": "peers", "prefix": "", "defaultValue": "2" },
    { "name": "backend", "prefix": "--", "defaultValue": "gpu", "choices": ["none", "cpu", "gpu"] },
    { "name": "releaseNotes", "prefix": "", "defaultValue": "Test build" }
  ]
}
```

## Argument model

Each placeholder maps to one argument entry:

- `name`: placeholder name without `${}` such as `epochs`
- `prefix`: what should be added before the value such as `-e`, `--`, `-s=`, or empty
- `defaultValue`: the value prefilled in the prompt
- `choices`: optional list for a clean menu instead of free text

Examples:

- `${epochs}` with `{ "name": "epochs", "prefix": "-e", "defaultValue": "5" }` becomes `-e 5`
- `${backend}` with `{ "name": "backend", "prefix": "--", "defaultValue": "gpu" }` becomes `--gpu`
- `${seeder}` with `{ "name": "seeder", "prefix": "-s=", "defaultValue": "Visualizer" }` becomes `-s='Visualizer'`
- `${mode}` with `{ "name": "mode", "prefix": "--", "defaultValue": "testing", "choices": ["testing", "real"] }` opens a choice menu

Known variables still get nicer prompts:

- `${peers}` validates `0-100`
- `${backend}` opens the backend choice menu
- `${releaseNotes}` opens the release notes input

`Upload` keeps a built-in `install` / `upload` selector and is not configured through `mlTorrent.arguments`.

Any other `${name}` placeholder is prompted automatically with its configured default value. If `choices` is set, it uses the same menu-style treatment as the built-in selectors.

## Migration Note

`mlTorrent.variableDefaults` is deprecated and ignored.

Keep defaults in one place only:

- use `mlTorrent.arguments`
- remove `mlTorrent.variableDefaults` from your user or workspace settings

## Development

This repo currently has no local Node toolchain installed, so to build it you need:

1. `node`
2. `npm`
3. `typescript` via `npm install`

Then run:

```bash
npm install
npm run compile
```

Open the workspace in VS Code and launch the `Run Extension` debug configuration.
