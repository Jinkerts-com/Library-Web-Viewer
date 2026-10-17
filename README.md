# Library Web Viewer

A web-based viewer for local asset libraries created with [Eagle App](https://eagle.cool/), built with Astro, React, and TailwindCSS.

This is an independent, open-source community project. It is not affiliated with, authorized, maintained, sponsored, or endorsed by Eagle.cool, OGDESIGN.INC, or the makers of Eagle App. Any references to Eagle, Eagle App, Eagle.cool, or OGDESIGN.INC are only for compatibility and identification purposes.

To clarify, this is not an Eagle replacement or an official Eagle product. This is simply a web-based viewer for compatible local libraries that can be self hosted to allow read-only remote access to your library. This app was built with mobile in mind and is optimized for touch interactions. Highly recommended to only use this behind a VPN or other secure connection.

I am not a security expert, and this app has not been audited for security. Use at your own risk.

## Features

- **Fast Performance**: Built on Astro for optimal performance.
- **Masonry Layout**: Justified and waterfall grid layouts.
- **Search & Filter**: Quickly find assets in your library.
- **Shape & Type Filters**: Header chips filter by aspect ratio (Horizontal, Vertical, Square, Panoramic, 4:3, 3:4, 16:9, 9:16, or a Custom `W : H`) and by file type. Each option shows a count for the current view; click a row to include it, use its minus button (or right-click / Alt-click) to exclude it. Shapes are overlapping application rules, not Eagle's: an item must have positive numeric width and height to match any shape (otherwise it matches none, not even Square); Horizontal/Vertical are `width > height` / `width < height`, Square is exactly equal, Panoramic is 2:1 or wider (1:2 or taller), and the named and Custom ratios match within an inclusive ±2% band. Counts are per option, so one image can count toward several shapes. The type list only offers extensions present in the current view (`jpg` and `jpeg` stay separate). `GET /api/items` takes repeated `shape`, `excludedShape`, `type`, `excludedType` params plus `ratioWidth`/`ratioHeight` (integers 1-10000, default 4:3) and returns `shapeCounts`/`typeCounts` on page 1; malformed values get HTTP 400.
- **Folder Navigation**: Browse your library's folder structure.
- **Tags and Information**: View tags and information for each asset.

## Prerequisites

- [Bun](https://bun.sh/) is **required**. The server and scripts use Bun's built-in `bun:sqlite`, so Node.js alone cannot run this app (the Docker image already includes Bun).

## Setup

1. **Install dependencies**:
   ```sh
   bun install
   ```

2. **Configure your library**:
   - Create a `.env` file in the root directory (you can copy from `.env.example`):
     ```sh
     cp .env.example .env
     ```
   - Open `.env` and set `LIBRARY_PATH` to the location of your `.library` folder. You can also configure optional thumbnail settings.
     ```env
     LIBRARY_PATH=C:\Path\To\Your\Library.library
     
     # Optional Thumbnail Settings (Default: 400 height, 80 quality)
     # THUMBNAIL_HEIGHT=400   # integer, 16-2000
     # THUMBNAIL_QUALITY=80   # integer, 1-100
     ```
     Invalid thumbnail values are ignored with a warning and the defaults are used.

3. **Initialize the local database (Optional but Recommended)**:
   - Run the initial setup script to create the local SQLite database from your Eagle metadata.
     ```sh
     bun run setup
     ```
   - *Note: If you add new images to your library later, you can run `bun run update` to sync the changes.*
   - *Note: If you need to completely wipe and recreate the database, you can use `bun run rebuild`. **Stop the server first** (in Docker: stop the container, run the rebuild against the same `db` volume, then start it again): a rebuild deletes the index database and the derived thumbnail/preview caches in `db/cache` (never your library).*
   - *Note: `setup`, `update`, `rebuild` and `generate-thumbnails` exit with code `0` on success, `1` on failure, and `2` for a partial result (the run finished but some items could not be read or processed). An empty library is a success, and unsupported items are skipped rather than counted as errors.*
   - *Note: Media responses use private revalidation (`ETag`/`Last-Modified`, `Cache-Control: private, no-cache`). The app requests media with a `?v=<epoch>` cache-policy parameter; a browser that cached the old unversioned URLs (from before this policy) may keep those bytes until its own cache expires.*

4. **Generate Thumbnails (Optional but Recommended)**:
   - For optimal performance, pre-generate thumbnails for all your images.
     ```sh
     bun run generate-thumbnails
     ```

## Docker Deployment

The application is published as a Docker image and can be self-hosted via Docker.

### Using Docker Compose
Create a `docker-compose.yaml` file:

```yaml
version: '3.8'

services:
  library-web-viewer:
    image: ghcr.io/jinkerts-com/library-web-viewer:latest
    container_name: library-web-viewer
    restart: unless-stopped
    ports:
      # Format is "HostPort:ContainerPort"
      # Change the FIRST number to adjust the port exposed on your machine (e.g., "8080:4321")
      - "4321:4321"
    environment:
      # Required: The path to your library folder IN THE CONTAINER
      - LIBRARY_PATH=/library

      # Optional thumbnail scaling/quality settings
      - THUMBNAIL_HEIGHT=400
      - THUMBNAIL_QUALITY=80

      # Optional initial theme: DARK (default) or LIGHT, case-insensitive
      - VIEWER_THEME=DARK

      # NOTE: ALLOWED_HOSTS only affects the development server (bun run dev). It does NOT
      # restrict access to this container. To limit who can reach it, publish the port on a
      # specific interface (e.g. "127.0.0.1:4321:4321"), use a firewall/VPN, or put a reverse
      # proxy in front that rejects unexpected Host names.
    healthcheck:
      # Same probe as the image's HEALTHCHECK (the slim image has no curl/wget).
      # Uses the container's PORT (default 4321); keep it in sync if you override PORT.
      test: ["CMD", "bun", "-e", "const h=process.env.HOST;const a=!h||h==='0.0.0.0'?'127.0.0.1':h==='::'?'[::1]':h.includes(':')&&h[0]!=='['?'['+h+']':h;fetch('http://'+a+':'+(process.env.PORT||4321)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    volumes:
      # Mount your library folder to the container (Format: HostPath:ContainerPath)
      # Read-only (:ro) is highly recommended for safety
      - "/mnt/Media/NAMEOFLIBRARY:/library:ro"

      # Persist the internal SQLite database so it doesn't rebuild on every container restart
      - ./library-db:/app/db
```

Run the stack in the background:
```sh
docker compose up -d
```

### Using Docker Run
If you prefer standard `docker run` instead of compose, use this equivalent command:

```sh
docker run -d \
  --name library-web-viewer \
  --restart unless-stopped \
  -p 4321:4321 \
  -e LIBRARY_PATH=/library \
  -v "/mnt/Media/NAMEOFLIBRARY:/library:ro" \
  -v ./library-db:/app/db \
  ghcr.io/jinkerts-com/library-web-viewer:latest
```

### Health check
`GET /api/health` is a lightweight readiness probe (the image's `HEALTHCHECK` and the compose `healthcheck` use it). It checks only that the library directory is configured and readable and that the index database answers a trivial query; it never scans, counts items or writes. A scan in progress is **not** unhealthy, and an empty library is healthy.

- Ready: HTTP `200` with `{"status":"ok","checks":{"library":"ok","database":"ok"}}`.
- Not ready: HTTP `503` with the same shape and `unavailable` / `not_configured` for the failing check. The body never contains filesystem paths or error text; details are written to the server log.

The probe runs `bun` inside the container because the slim image has no `curl` or `wget`. With `docker run`, `--health-cmd` can use the same command; `docker ps` / `docker inspect` then show `healthy` or `unhealthy`.

## Usage

**Development Server**:
```sh
bun run dev
```

**Build for Production**:
```sh
bun run build
```

**Start Production Server**:
- By default, this binds to `0.0.0.0` so the viewer can be accessed from other devices on your local network.
```sh
bun run start
```

To bind to a specific address, pass `--host`:
```sh
bun run start -- --host 127.0.0.1
```

You can also set the host and port with flags or environment variables:
```sh
bun run start -- --host 192.168.1.50 --port 8080
HOST=192.168.1.50 PORT=8080 bun run start
```

Environment variables for the server (all optional except `LIBRARY_PATH`; see `.env.example`):

- `HOST` / `PORT`: bind address (default `0.0.0.0`) and port (default `4321`); the `--host` / `--port` flags override them. In Docker these are set to `0.0.0.0` / `4321` by the image; change the published port in `ports:` rather than `PORT`. The healthcheck already reads the container's own `PORT`, but it runs as a separate process whose environment launch flags such as `--port` cannot change, so if you override the port, set it via the container environment (`PORT`) and make the container-side port mapping match.
- `VIEWER_THEME=DARK|LIGHT`: initial viewer theme (case-insensitive; invalid or unset means dark). A theme already saved in the browser by the theme toggle overrides it. It is read per request, so restarting the server or container is enough (no rebuild). **Note:** the viewer previously defaulted to light for first-time visitors; the built-in default is now dark, so set `VIEWER_THEME=LIGHT` to keep the old look.
- `VERBOSE=true`: verbose logging (the `setup`, `update` and `rebuild` scripts enable it themselves).
- `ALLOWED_HOSTS`: **development server only** (`bun run dev`). It is not read by the production server or the Docker image and does not restrict access there; see Request protection below.

## Request protection

These are defense-in-depth measures, **not authentication**; there is no account system.

- **Rate limits** (HTTP 429 with a `Retry-After` header): `POST /api/unlock` (default 10 attempts per client per 60 s, to slow password guessing) and `POST /api/scan` (default 5 per client per 60 s). Scans also have a global cooldown (default 10 s after one starts or finishes; a running scan still answers `409`). Blocks expire on their own, and tracked clients are capped (10,000) so memory stays bounded. Tune with `UNLOCK_RATE_LIMIT`, `UNLOCK_RATE_WINDOW_SECONDS`, `SCAN_RATE_LIMIT`, `SCAN_RATE_WINDOW_SECONDS`, `SCAN_COOLDOWN_SECONDS` (see `.env.example`). Counters live in the server process; multiple instances do not share them.
- **Client address**: the address of the TCP connection as reported by the server adapter. `X-Forwarded-For` and similar headers are deliberately ignored because any client can forge them. Behind a reverse proxy all requests therefore share the proxy's address (one bucket); there is no trusted-proxy option.
- **Same-origin checks** on `POST /api/scan`, `/api/unlock` and `/api/lock` (HTTP 403): a request is rejected if it sends `Sec-Fetch-Site: cross-site` or `same-site`, or an `Origin` that does not match the `Host` it was addressed to (a `Referer` is checked the same way only when neither `Origin` nor `Sec-Fetch-Site` is sent). A matching `Origin`/`Referer` is **not** mandatory: requests with `Sec-Fetch-Site: same-origin` or `none` and no `Origin` are accepted, and so are requests with **no** `Origin`, `Referer` or `Sec-Fetch-Site` at all (curl, scripts), since they are not subject to cross-site request forgery; all of them are still rate limited.
- **DNS rebinding**: these checks do **not** prevent DNS rebinding in production. `ALLOWED_HOSTS` is a **development-only** setting (it is passed to the dev server's `allowedHosts`) and the production server (`bun run start`) does not enforce a hostname allowlist. If the viewer is reachable by anything you do not trust, restrict it at the network level (bind to `127.0.0.1` or a specific interface with `--host`, firewall the port) and/or put it behind a reverse proxy that rejects unexpected `Host` names.
- **Cookies**: the folder-unlock cookie is a session cookie (no expiry). It is marked `Secure` automatically on HTTPS requests; plain-HTTP LAN access is unaffected. Behind a TLS-terminating proxy (the app only sees HTTP) set `COOKIE_SECURE=true`; set `COOKIE_SECURE=false` to never add the attribute. Leave it unset for plain-HTTP LAN use. `X-Forwarded-Proto` is not trusted.
- Lock metadata that failed to load is retried at most every few seconds instead of on every request, and a library with no folders is initialized once, not rescanned on every metadata request.

## Performance and capacity

**Single process only.** Scan locking, rate limits, the scan cooldown, the unlock/lock state and the scan-status stream (SSE) all live in the memory of one server process. Run exactly one instance per library; several instances (replicas, or one container plus `bun run dev`) would each scan, rate-limit and push events independently with no coordination. Distributed scan locking is deliberately not implemented; it would be needed before multi-instance deployment is supported.

**Watcher polling.** The watcher uses chokidar with `usePolling: true` (file-system events are unreliable on network shares/NAS and Docker bind mounts) and polls every `WATCH_POLL_INTERVAL_MS` (default `2000`, allowed `500`-`60000`; invalid values fall back to the default and out-of-range values are clamped). Polling stats every watched file each interval, so CPU and I/O (and NAS wake-ups) grow with the number of files in `images/`; on a large library or slow share raise the interval (changes are then noticed up to that much later). Polling cost was not benchmarked on a real NAS or on large libraries; only the numbers below were measured.

**Scan-status stream.** Each open `/api/status/stream` connection holds one `progress` and one `complete` listener plus a 15 s heartbeat timer, all released on abort, cancel or enqueue failure (cleanup is idempotent). Node warns when one event has more than 10 listeners, so the cap is raised to a bounded `SSE_MAX_LISTENERS` (default `100`, clamped to `10`-`1000`). It is not a connection limit and is never set to unlimited, so a genuine leak still produces `MaxListenersExceededWarning`; `tests/sseLifecycle.test.ts` asserts that listener, timer and abort-listener counts return to baseline after repeated open/abort/cancel cycles.

**Measured numbers** (Windows 11 desktop, 16-thread desktop CPU, Bun 1.3.6, `db/` on a local drive, library on a mapped network share; indicative single runs):

| Measurement | Result |
|---|---|
| Full scan, 88 items, fresh database (88 upserts) | 76 ms |
| Re-scan, 88 items unchanged (88 skipped), several runs | 150-320 ms |
| Sorting the item-folder name list (`.sort()`), synthetic | 5,000 names: ~2 ms; 100,000 names: ~36 ms |

The sort is O(N log N). In the measured 88-item workload it is negligible next to the per-item work (a 5,000-name sort is ~2 ms against a 76-150+ ms scan of only 88 items); the 100,000 figure is a synthetic in-memory name list, not a scan of a 100k-item library, whose total scan time is unmeasured.

**Watcher polling cost and latency** (same machine; indicative, single runs). The watcher uses chokidar polling (`WATCH_POLL_INTERVAL_MS`, default 2000 ms) because native file events are unreliable on network shares.

| Measurement | Result |
|---|---|
| Storage | `S:` is a mapped network drive (SMB share over LAN, not a local disk) |
| Workload | Production `db.ts` watcher against the real 88-item library (339 watched entries in 90 directories), 2000 ms polling, run read-only with a temporary working directory and database; observed for 226 s with no library changes |
| Idle CPU | ~9% of one logical core of the Bun process (21.2 s CPU in 226 s; ~9.2% cumulative over the run, stable). The 5800X has 16 logical cores, so this is ~0.6% of total CPU. RSS ~215-225 MB (includes the loaded app, not only the watcher) |
| Idle I/O | Process-level counters showed 0 read ops/bytes and ~1 write per 30 s (SQLite housekeeping in the temp DB); ~1.25 million "other" I/O operations (~5,500/s, which on Windows includes file metadata/stat queries). Network traffic and server-side load were not measured |
| Change detection (temp fixture library on local disk, 6 items, 2000 ms polling, 6 `metadata.json` edits at random phase) | Watcher event 33 / 547 / 2009 / 2261 / 2423 / 3605 ms after the write; item visible in the index 563 / 1091 / 2525 / 2779 / 2966 / 4137 ms after the write (includes the 500 ms debounce). Expect latency of roughly one to two polling intervals plus the debounce, not exactly 0-2000 ms |

Not measured: a large library (scan or watcher), a real NAS appliance under load, network-side traffic, other polling intervals, or change-detection latency on the network library (the latency edits ran on a local-disk fixture because the real library is never written to). Idle polling cost grows with the number of watched files, so a much larger library on network storage will cost proportionally more; raise `WATCH_POLL_INTERVAL_MS` to reduce it at the price of slower change detection.

## Notes

- Ensure your library path is accessible by the application.

## License

Apache License 2.0
