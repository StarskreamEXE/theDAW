# Pinokio launcher

## What the launcher is

The Pinokio launcher is a one-click installer and runner for theDAW. It wraps the install and startup steps so theDAW can be set up and launched from the Pinokio app without terminal commands. The launcher lives on GitHub at github.com/gantasmo/theDAW-Pinokio. It clones and runs theDAW from github.com/gantasmo/theDAW.

The launcher exposes four actions in Pinokio: Install, Start, Update, and Reset. A fifth menu, Download Models, fetches the other Stable Audio 3 checkpoints.

## Install

Install prepares theDAW and every sidecar it uses. It runs these steps in order:

- Clone theDAW into an `app/` folder next to the launcher. This step runs only when `app/` does not already exist.
- Pull the Magenta sidecar submodule with `git submodule update --init --recursive`.
- Set `git config core.hooksPath .githooks` in `app/`, so the repo's own commit hooks are active. `theDAW.bat` and `theDAW.sh` set the same value on every launch.
- Install FFmpeg through conda when no `ffmpeg` is on the PATH. An FFmpeg already on the machine is left as it is.
- On Linux, install the C and C++ compilers, make and pkg-config through conda, for the packages that build from source.
- Resolve all Python dependencies with `uv sync --group dev`. On Linux a sync that fails on `pyk4a-bundle` (the Azure Kinect backend, which needs glibc 2.38) is retried without that package. On macOS the sync runs with `CFLAGS=-Wno-incompatible-function-pointer-types`.
- Build the Underfit trainer environment in `app/underfit` with `uv sync --inexact`, when the trainer is present and its venv does not exist yet.
- Install the frontend packages in `app/frontend` with `npm install`.
- Install the VST Foundry packages in `app/VST-Foundry-UI/VST-UI-FOUNDRY` with `npm install`, when that folder exists.
- Clone the VJ-9000 app into `app/vj` when it is missing, run `npm install` there, and record its install-script approvals with `npm approve-scripts`.
- Clone SwayCommand next to the launcher when it is missing, install esbuild and three, and run `npm run build:renderer:embed`. The SWAY tab is served from that build. theDAW finds `SwayCommand/dist-embed` beside the launcher on its own.
- Pre-fetch the default generation model from the public mirror into the user Hugging Face cache: Medium on Windows and Linux, Small on macOS. The step is skipped when the model is already in the cache.

Any other model downloads the first time a generation needs it, once downloads are allowed in Settings > Models.

## Start

Start launches theDAW as a daemon and opens the app. It runs a preflight and two servers:

- Start first runs `uv run --no-sync python -m backend.ports --free`, which stops theDAW's own stale listeners on 5173 and 8600. `theDAW.bat` and `theDAW.sh` do the same thing with a shell pipeline before they launch; this step is the portable equivalent. It only stops a process it can identify as theDAW's, running from this checkout, so a program of yours that happens to hold one of those ports is reported and left alone.
- The FastAPI backend starts with `uv run --no-sync python -m backend._supervisor`, which runs `backend.run` and relaunches it in place when the app asks for a restart or an update. Start waits until the backend reports that Uvicorn is running.
- The Vite frontend starts with `npm run dev`. Start captures the local URL the frontend prints and opens the app at that URL.

The backend serves on port 8600. The frontend serves on port 5173. If a port is held by something theDAW cannot stop, the backend says which program and process holds it, and Start ends there.

Settings > Restart Server works under the launcher: the supervisor brings the backend back inside the same Pinokio terminal. Settings > Check for Updates works the same way: the backend pulls, exits with code 89, the supervisor syncs the dependencies and respawns it, and the page reconnects.

## Update

Update moves the launcher and the app to their latest published versions and re-syncs every dependency tree. It runs these steps in order:

- `git pull` in the launcher folder.
- `git fetch origin main` and `git reset --hard FETCH_HEAD` in `app/`. The app clone is launcher-managed, and a plain pull failed whenever `npm install` or `uv sync` had rewritten a tracked lockfile, or the clone carried a local commit. Untracked and ignored content (`data/`, `vj/`, `.venv`, `node_modules`, downloaded models) is never touched.
- `git submodule update --init --recursive` and `git config core.hooksPath .githooks` in `app/`.
- `uv sync --group dev`, with the same Linux retry and macOS flags as Install.
- `uv sync --inexact` in `app/underfit`, only when a previous Install or the app's self-repair built that venv.
- `npm install` in `app/frontend`, and in the VST Foundry folder when it exists.
- Clone VJ-9000 into `app/vj` when it is missing, then `npm install` and `npm approve-scripts` there.
- Clone SwayCommand when it is missing, then `git fetch --depth 1 origin main`, `git reset --hard FETCH_HEAD`, install esbuild and three, and rebuild the cockpit with `npm run build:renderer:embed`.

Pinokio loads the launcher's own scripts before its first step pulls the launcher, so a change to Update itself reaches an install on the run after the one that pulled it.

## Reset

Reset deletes the dependency trees only. It removes `app/.venv`, `app/frontend/node_modules`, `app/vj/node_modules`, `app/underfit/.venv` and `app/VST-Foundry-UI/VST-UI-FOUNDRY/node_modules`, each only when it exists. The `app/` folder itself stays, so the library, settings and generated audio under `app/data` are kept. The next Install skips the clone step and rebuilds the dependency trees from clean.

## Download Models

The Download Models menu fetches the other Stable Audio 3 checkpoints on demand: Small ARC, Small RF, Medium ARC and Medium RF. Each goes into the user Hugging Face cache described below.

## Ports

- Backend (FastAPI): port 8600. Interactive API docs are at `http://localhost:8600/docs` while the backend runs.
- Frontend (Vite): port 5173.
- VJ sidecar: port 5187, spawned by the backend on first use.

Both servers bind `0.0.0.0`, so the web UI, the phone companion, Quest streaming and XR control are reachable from other devices on the same network.

## Hugging Face cache and gated repositories

The launcher sets `HF_HOME` to the standard user Hugging Face cache at `~/.cache/huggingface`. The launcher does not use an isolated per-app cache. An existing Hugging Face token and any checkpoints already downloaded on the machine are reused, so a shared install does not download the same weights twice.

The official Stable Audio 3 and t5gemma repositories are gated. theDAW falls back to a public mirror of the same weights by itself, and Install pre-fetches the default model from that mirror. A Hugging Face token with access granted to the official repositories unlocks them. Provide the token through the in-app sign-in or `hf auth login`. Once the token is stored in the standard cache, later downloads reuse it.

## First run

1. In Pinokio, open theDAW and click Install. Wait for the dependency sync and the model pre-fetch to finish.
2. Click Start. The backend comes up first, then the web UI. The Open App tab appears when the frontend URL is ready.
3. Open the MAKE tab, type a prompt, and press CREATE. The pre-fetched default model is used. Any other model downloads once downloads are allowed in Settings > Models. The `small` model runs on a CPU; `medium` needs an NVIDIA GPU.
4. Right-click the new track in the library to open it in EDIT, MIX, SCORE or SING, or to load it on a DJ deck.

## When something breaks

- A dependency tree is wedged: run Reset, then Install. The library and settings under `app/data` are untouched.
- Start fails at once on a port: close whatever holds 5173 or 8600, for example a copy launched through `theDAW.bat`, and start again.
- The SWAY tab is empty: run Update, which rebuilds the SwayCommand cockpit.
- The VJ tab is broken: run Update, which re-clones `app/vj` when it is missing.
