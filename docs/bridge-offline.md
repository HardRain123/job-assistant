# Offline Codex bridge image

The offline bridge image uses the already built local `job-assistant-app:latest` image. It adds Codex CLI 0.156.1 from two official npm archives without contacting a package registry or Docker Hub. The Dockerfile pins and checks each archive's SHA-512 before extraction.

Place these exact files in `data/offline/`:

- `codex-0.156.1.tgz` — `@openai/codex@0.156.1`
- `codex-0.156.1-linux-x64.tgz` — `@openai/codex@0.156.1-linux-x64`

The `data/` directory is excluded from the main Docker context. The two archives enter the build only through the named `codex_offline` context. On Windows, add your Docker Desktop installation's `resources/bin` directory to `PATH` if `docker` is not available in the shell.

From the repository root, build the bridge image without network access:

```sh
docker build --pull=false --network=none --build-context codex_offline=./data/offline -f Dockerfile.bridge.offline -t job-assistant-bridge:latest .
```

Check the CLI without starting a service or publishing a port:

```sh
docker run --rm --network none job-assistant-bridge:latest codex --version
```

To use the offline image with the existing deployment, include `deploy/compose.offline.yaml` after `compose.yaml` in Compose commands. For example, after the app and volume initialization are running:

```sh
docker compose -f compose.yaml -f deploy/compose.offline.yaml --profile chatgpt up -d --no-build --no-deps bridge
```

The bridge retains the base Compose service's dedicated `codex_home` volume, read-only root filesystem, dropped capabilities, private app network namespace, and internal-token secret. Account sign-in and model selection happen through the application; the offline build never reads host Codex credentials.

The image exports Node's bundled public root certificates for Codex's native TLS client, preserving certificate validation without an OS package download. For networks requiring an existing proxy, see the optional `compose.proxy.yaml` override in [deployment.md](deployment.md).
