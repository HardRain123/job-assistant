# Docker deployment

Docker Compose runs the application as three services. Only `app` publishes a host port, fixed to `127.0.0.1:3000`. `worker` and the optional `bridge` share the app's network namespace and bind private loopback ports 3001 and 3002.

Browser task processing and the local desktop takeover path are enabled in this configuration. The desktop is available only through the application's password-authenticated `/browser` proxy while a takeover is active. noVNC, websockify, VNC, worker, and bridge ports remain private loopback listeners in the shared network namespace; only port 3000 is published, and it is never bound outside the Docker host. The ordinary browser extension provides a separate collection path; live submission remains disabled until selectors and receipts have been verified. Do not publish ports 3001, 3002, 5900, 6080, or 6081.

## Start

From the repository root, initialize secrets and start the stack:

Use Compose 2.17 or newer: the worker build reuses the app image's Node runtime and dependencies through `additional_contexts`.

```sh
sh deploy/start.sh
```

On Windows PowerShell:

```powershell
.\deploy\start.ps1
```

The secret initializer creates `.secrets/internal_token`, `.secrets/app_key`, and `.secrets/app_password` only when missing. It never replaces an existing value. It prints a generated password once; save it before closing the terminal. Set `APP_PASSWORD` for the POSIX script or pass `-AppPassword` to the PowerShell script to choose the initial password yourself.

Use `sh deploy/start.sh -d` or `.\deploy\start.ps1 -Detached` to run in the background. The loopback binding is fixed in Compose and is intentional.

To enable the Codex bridge, run `CHATGPT=1 sh deploy/start.sh -d` or `.\deploy\start.ps1 -Detached -ChatGPT`. The bridge keeps its own `CODEX_HOME` Docker volume and never mounts host credentials. The installed CLI is pinned to `@openai/codex` `0.156.1`; update it deliberately through `JOB_ASSISTANT_CODEX_VERSION` and test the bridge before deploying. The project-specific variable prevents a host Codex installation's `CODEX_VERSION` from overriding this pin. Complete device-code login through the application before choosing a Codex model.

The bridge accepts only the application's internal bearer token. Before `/chat`, it verifies that command tools, apps, multi-agent tools, hooks, web search, and MCP servers are disabled. A failed check returns `tool_isolation_unverified`; account and model discovery can still work. Scoring uses the named `job_scoring` permission profile with minimal/workspace read access and command networking disabled. Both thread and turn explicitly set `environments: []`, exposing no execution environment. This matches the pinned CLI's current protocol; the removed `readOnly.access` field must not be restored. The bridge interrupts a turn if a tool item appears. Verify a live response before relying on Codex scoring.

## Local model gateway

For interrupted large npm downloads, use the [offline bridge build](bridge-offline.md). Both bridge Dockerfiles provide Codex's native TLS client with Node's bundled public CA roots via `SSL_CERT_FILE`; TLS verification stays enabled.

If ChatGPT requires an existing outbound HTTP proxy, apply the optional proxy override (replace the example port with your proxy's port):

```powershell
$env:JOB_ASSISTANT_PROXY = 'http://host.docker.internal:10808'
docker compose -f compose.yaml -f deploy/compose.offline.yaml -f deploy/compose.proxy.yaml --profile chatgpt up -d --no-build
```

Omit `compose.offline.yaml` if using the normal bridge image. Keep the proxy override in subsequent Compose commands that recreate services. Only the bridge receives this proxy; internal loopback requests bypass it. Do not put proxy credentials in a committed file. The device flow follows the [official App Server auth protocol](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

When a model provider runs on the Docker host, enter a base URL such as `http://host.docker.internal:11434/v1` in the application's provider settings.

The Compose file maps `host.docker.internal` to Docker's host gateway for Linux Docker Engine and Docker Desktop. Do not use `localhost` for a provider that runs on the host, because `localhost` inside the app container is the container itself.

## Storage and backups

The Compose volumes have separate purposes:

| Volume            | Mounted service                  | Contents                          |
| ----------------- | -------------------------------- | --------------------------------- |
| `sqlite_data`     | app                              | SQLite database                   |
| `attachments`     | app read/write, worker read-only | uploaded source files             |
| `evidence`        | app and worker read/write         | reserved browser evidence storage |
| `browser_profile` | worker                           | persistent headed browser session |
| `codex_home`      | optional bridge                  | Codex state and credentials       |

Back up the database through the authenticated API. The API's `POST /api/backup` endpoint creates a consistent SQLite backup; do not copy a live database file out of the volume.

```sh
BACKUP_DIR=/safe/backups sh deploy/backup.sh
```

```powershell
.\deploy\backup.ps1 -BackupDir 'D:\backups'
```

The scripts log in with the workbench password and the returned session cookie, then write a completed backup only after the API request succeeds. They prompt for the password unless `APP_PASSWORD` is set; PowerShell also accepts `-AppPassword`. The POSIX script requires `curl` and `jq`. Both scripts delete the temporary session cookie. Place `BACKUP_DIR` or `-BackupDir` on storage covered by your backup policy. Back up attachments separately, and stop the stack before copying Docker volumes with active browser or Codex session state.

## Security model

The application receives the login password and encryption key; browser worker and bridge receive only the internal service token. The worker has no mount for the SQLite database or encryption/login secrets. Chromium runs as the image's `pwuser`, with all Linux capabilities dropped, `no-new-privileges`, an explicit Playwright-derived seccomp policy that permits unprivileged user namespaces, a private writable `/tmp`, and a 1 GiB shared-memory allocation. The seccomp profile returns `ENOSYS` for `clone3`, allowing glibc and Node to use their safe `clone` fallback rather than failing thread creation with `EPERM`. The deployment does not use privileged mode or Chromium's `--no-sandbox` flag.

`Dockerfile.worker` uses `mcr.microsoft.com/playwright:v1.56.1-noble`, matching the repository's pinned `playwright` npm dependency. Keep these versions equal when upgrading.

The seccomp policy also allows `arch_prctl` for x86-64 glibc thread-local storage, and `chroot` for Chromium's sandbox setup inside its unprivileged user namespace. Removing these can prevent the shell or browser from starting; neither grants host capabilities.

The app hostname is fixed because the worker shares its namespace and Chromium includes that hostname in its profile lock. Shutdown asks the browser to close before stopping X11. After a crash, do not delete the browser profile: first confirm no container or browser process still owns it, then remove only the verified stale `SingletonLock`, `SingletonCookie`, and `SingletonSocket` symlinks if necessary. A graceful restart may still leave lock files; Chromium can normally recognize a stale local owner when the hostname remains stable.

Chromium also needs `/home/pwuser/.pki` to initialize its NSS certificate database. A 16 MiB, UID/GID 1001-only tmpfs supplies this directory; the root filesystem remains read-only and certificate verification remains enabled. This temporary certificate store is independent of the persistent browser profile.

## Health and troubleshooting

### Ordinary browser companion

The native Chrome/Edge extension in `apps/browser-extension` connects to the Docker API at `http://127.0.0.1:3000`. Load this directory as an unpacked extension and generate a pairing code from the authenticated workbench's Browser page. No additional Docker port or service is required. Version 0.2.4 supports bounded search, pagination and detail collection, including clicking cards and reading the matching inline detail pane in the newer split layout, followed by optional backend scoring. Start these tasks from the workbench's automatic job search page; a manual import remains available in the popup. Pairing uses an origin-bound, revocable credential and exposes no messaging commands. Reload the installed extension after updating its files; restarting Docker alone does not reload browser code. Live submission remains disabled. See [installation and research](browser-extension.md); this host has a paired extension, but real BOSS DOM validation remains pending.

Compose checks `GET /health` on app, worker, and optional bridge. These report process liveness; they do not prove model login or browser task readiness. Inspect a service with `docker compose logs app`, `docker compose logs worker`, or `docker compose --profile chatgpt logs bridge`. The worker waits for Xvfb to accept display connections before starting VNC, noVNC, nginx, and the browser process; a failed readiness check causes the worker service to exit. A browser that fails to start because the host disallows unprivileged user namespaces is a host security-policy issue; do not work around it by disabling Chromium's sandbox.

## Verification status

Docker 29.8.0's Linux engine runs all three built services; only `127.0.0.1:3000` is published. Workbench login, migrated local data, read-only worker attachment access, real Chromium/noVNC takeover, and ending takeover have been exercised. The offline Codex CLI reports 0.156.1. Device authorization and model discovery succeeded, and credentials survived a Docker restart. An anonymous model request and the deployed workbench connection test now pass. The earlier workspace-requirements error came from a missing `default_permissions` in the scoring session config: routing rebuilds the configuration without the request-level permission selection. The same restricted profile is now explicitly selected as the default; no proxy change or permission relaxation was needed. Live BOSS navigation/collection/submission is still pending; see [verification.md](verification.md).
