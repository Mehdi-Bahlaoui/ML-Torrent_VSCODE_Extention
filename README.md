# ML-Torrent Tools

VS Code extension that adds `Check`, `Run`, and `Upload` status bar actions for an ML-Torrent-style workspace.

## Features

- `Check` prompts for a Cargo workspace crate, then runs the configured check command.
- `Run` prompts for peer count and backend mode, then runs the configured launch command.
- `Upload` prompts for either install or upload, and requests release notes for upload.
- Commands run in a reusable integrated terminal named `ML-Torrent` so the process stays available in the terminal panel.

## Default configuration

```json
{
  "mlTorrent.projectRoot": "../dfl",
  "mlTorrent.checkCommandTemplate": "cargo check -p ${crate}",
  "mlTorrent.runCommandTemplate": "./run.sh ${peers} ${backendFlag}",
  "mlTorrent.uploadInstallCommandTemplate": "cd \"gui/ML-Torrent App\" && ./mobile-app.sh install",
  "mlTorrent.uploadReleaseCommandTemplate": "cd \"gui/ML-Torrent App\" && ./release.sh ${releaseNotes}"
}
```

## Placeholder values

- `${crate}`: selected Cargo package name
- `${peers}`: peer count input
- `${backendFlag}`: `-t`, `--cpu`, or `--gpu`
- `${releaseNotes}`: shell-escaped upload notes

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
