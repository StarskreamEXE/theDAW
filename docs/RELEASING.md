# Releasing theDAW

This document is the full recipe for cutting a release. The automation
lives in `.github/workflows/release.yml`.

## Version authority and sync rule

`electron-ui/package.json` holds the canonical application version.
`pyproject.toml` must carry the identical version string at all times.
The release workflow fails fast when the pushed tag, `electron-ui/package.json`,
and `pyproject.toml` disagree, so every version bump touches both files in
the same commit.

Tags follow v-prefixed semver: tag `v0.2.0` corresponds to version `0.2.0`
in both files.

## Release recipe

1. Bump `version` in `electron-ui/package.json` to the new `X.Y.Z`.
2. Bump `version` in `pyproject.toml` to the identical `X.Y.Z`.
3. Bump both root `version` lines in `electron-ui/package-lock.json` to match.
   `npm ci` refuses to run when the lock disagrees with its `package.json`.
4. Run `uv lock` to carry the version into `uv.lock`, then
   `python scripts/check_lock.py`.
5. Commit all four files together on `main`.
6. Create the tag: `git tag vX.Y.Z`.
7. Push the tag: `git push origin vX.Y.Z`.

The tag push triggers the Release workflow.

Only `version-check` reads `electron-ui/package.json` and `pyproject.toml`, so
a bump that skips the two lockfiles passes the version gate and fails later in
the installer jobs.

## What CI produces on a tag push

The workflow runs four jobs:

- `version-check` verifies that the tag, `electron-ui/package.json`, and
  `pyproject.toml` all declare the same version, then creates a DRAFT
  GitHub Release named `vX.Y.Z`.
- `windows-exe` builds `theDAW-Setup-X.Y.Z.exe` (NSIS installer), uploads
  it as a workflow artifact (7-day retention), and attaches three files to
  the draft release: the installer, `theDAW-Setup-X.Y.Z.exe.blockmap` and
  `latest.yml`. The last two are the electron-updater feed; a step ahead of
  the upload fails the build when electron-builder has not written them.
- `macos-dmg` builds `theDAW-X.Y.Z-arm64.dmg` (Apple Silicon only),
  uploads it as a workflow artifact (7-day retention), and attaches it to
  the draft release.
- `docker-ghcr` builds the root `Dockerfile` and pushes
  `ghcr.io/gantasmo/thedaw:X.Y.Z` and `ghcr.io/gantasmo/thedaw:latest`.

CI never publishes the GitHub Release. A maintainer finishes the release
manually: open the draft release on GitHub, confirm all four assets are
attached (the installer, its blockmap, `latest.yml` and the dmg), write the
release notes, and click "Publish release" (or run
`gh release edit vX.Y.Z --draft=false`).

## Manual dispatch builds

Running the workflow via `workflow_dispatch` produces a dry build without
a release. The version is taken from `electron-ui/package.json`, the
installers exist only as 7-day workflow artifacts, and the Docker job
pushes `ghcr.io/gantasmo/thedaw:sha-<shortsha>` instead of `:latest`.

## Local builds

CI builds with Node 22, pinned as `NODE_VERSION` in
`.github/workflows/release.yml`. Local builds should use the same major
version.

- Windows installer: run `npm ci` in `frontend/` and `electron-ui/`, then
  `npm run dist:win` inside `electron-ui/`. The installer lands at
  `electron-ui/release/theDAW-Setup-X.Y.Z.exe`.
- Docker: run `docker compose up` from the repo root to build and start
  the image locally.

## In-app updates

Settings > Check for Updates installs releases in place, so a release is not
finished until it is **published** (drafts are invisible to every updater):

- **Packaged Windows app**: electron-updater reads `latest.yml` from the
  newest published release, downloads `theDAW-Setup-X.Y.Z.exe` (with its
  `.blockmap` for delta downloads), quits and runs it. The workflow attaches
  all three; `publish: github` in `electron-ui/electron-builder.yml` is what
  makes electron-builder emit the feed files. Releases up to and including
  v0.1.9 carry the installer alone, so a packaged app on one of those can
  only open the release page; v0.2.0 is the first release the updater can
  read.
- **Packaged macOS app**: unsigned, so it cannot self-update; the button
  downloads the new dmg from the release assets.
- **Clones** (theDAW.bat, theDAW.sh, Pinokio): the backend runs
  `git pull --ff-only`, exits with code 89, and the supervisor
  (`backend/_supervisor.py`, `backend/_devstack.py`) runs `uv sync` and
  `npm install` before respawning (`backend/_update_sync.py`). Clones follow
  `main`, so what they get is whatever is on `main` at that moment.

## The SwayCommand cockpit

The installer jobs build the SwayCommand embed bundle (the SWAY tab) from a
checkout of `danieljtrujillo/SwayCommand`. That repository is public, so the
workflow's built-in `GITHUB_TOKEN` reads it and no secret is required.

`SWAY_REPO_TOKEN` is still honoured when it exists — a fork that wants to
build from its own private cockpit sets it as an Actions repository secret
with `Contents: read` — and `version-check` reports which credential the
installer jobs will use. It does not fail when the secret is absent. It used
to, which broke every fork run and the v0.1.4 tag build, where both installer
jobs died in the SwayCommand fetch step.

Each installer job checks SwayCommand out at the commit pinned as
`SWAY_REF` in `.github/workflows/release.yml` and hands the path to
`electron-ui/scripts/fetch-sway-build.mjs` through `SWAY_PROJECT`; the
script runs `npm run build:renderer:embed` there. Bump `SWAY_REF` when a
newer cockpit should ship. No SwayCommand release asset is involved.

## Signing status

- The Windows installer is unsigned. SmartScreen shows a warning on first
  run; choosing "More info" and then "Run anyway" proceeds with the
  install.
- The macOS disk image is unsigned and un-notarized, and it targets arm64
  (Apple Silicon) only. Gatekeeper blocks a plain double-click. Either
  right-click (Control-click) the app and choose "Open", or clear the
  quarantine attribute:
  `xattr -d com.apple.quarantine /Applications/theDAW.app`.
- First launch of the desktop app bootstraps the Python backend with uv
  and downloads several GB of dependencies and model weights.

## Docker image usage

```bash
docker run --rm -p 8600:8600 ghcr.io/gantasmo/thedaw:latest
```

The app is then reachable at `http://localhost:8600`.
