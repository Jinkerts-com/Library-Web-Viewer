# Library Web Viewer

A web-based viewer for local asset libraries created with [Eagle App](https://eagle.cool/), built with Astro, React, and TailwindCSS.

This is an independent, open-source community project. It is not affiliated with, authorized, maintained, sponsored, or endorsed by Eagle.cool, OGDESIGN.INC, or the makers of Eagle App. Any references to Eagle, Eagle App, Eagle.cool, or OGDESIGN.INC are only for compatibility and identification purposes.

To clarify, this is not an Eagle replacement or an official Eagle product. This is simply a web-based viewer for compatible local libraries that can be self hosted to allow read-only remote access to your library. This app was built with mobile in mind and is optimized for touch interactions. Highly recommended to only use this behind a VPN or other secure connection.

I am not a security expert, and this app has not been audited for security. Use at your own risk.

## Features

- **Fast Performance**: Built on Astro for optimal performance.
- **Masonry Layout**: Justified and waterfall grid layouts.
- **Search & Filter**: Quickly find assets in your library.
- **Folder Navigation**: Browse your library's folder structure.
- **Tags and Information**: View tags and information for each asset.

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or newer, or [Bun](https://bun.sh/) (recommended)

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
     # THUMBNAIL_HEIGHT=400
     # THUMBNAIL_QUALITY=80
     ```

3. **Initialize the local database (Optional but Recommended)**:
   - Run the initial setup script to create the local SQLite database from your Eagle metadata.
     ```sh
     bun run setup
     ```
   - *Note: If you add new images to your library later, you can run `bun run update` to sync the changes.*
   - *Note: If you need to completely wipe and recreate the database, you can use `bun run rebuild`.*

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

      # Optional: Restrict what domains/IPs can access the app (e.g. your-nas.local,192.168.1.50)
      # If this is omitted, the app defaults to accepting all incoming requests
      # - ALLOWED_HOSTS=

      # Optional thumbnail scaling/quality settings
      - THUMBNAIL_HEIGHT=400
      - THUMBNAIL_QUALITY=80
      - THUMBNAIL_WEBP=true
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

## Request protection

These are defense-in-depth measures, **not authentication**; there is no account system.

- **Rate limits** (HTTP 429 with a `Retry-After` header): `POST /api/unlock` (default 10 attempts per client per 60 s, to slow password guessing) and `POST /api/scan` (default 5 per client per 60 s). Scans also have a global cooldown (default 10 s after one starts or finishes; a running scan still answers `409`). Blocks expire on their own, and tracked clients are capped (10,000) so memory stays bounded. Tune with `UNLOCK_RATE_LIMIT`, `UNLOCK_RATE_WINDOW_SECONDS`, `SCAN_RATE_LIMIT`, `SCAN_RATE_WINDOW_SECONDS`, `SCAN_COOLDOWN_SECONDS` (see `.env.example`). Counters live in the server process; multiple instances do not share them.
- **Client address**: the address of the TCP connection as reported by the server adapter. `X-Forwarded-For` and similar headers are deliberately ignored because any client can forge them. Behind a reverse proxy all requests therefore share the proxy's address (one bucket); there is no trusted-proxy option.
- **Same-origin checks** on `POST /api/scan`, `/api/unlock` and `/api/lock` (HTTP 403): a request is rejected if it sends `Sec-Fetch-Site: cross-site` or `same-site`, or an `Origin` that does not match the `Host` it was addressed to (a `Referer` is checked the same way only when neither `Origin` nor `Sec-Fetch-Site` is sent). A matching `Origin`/`Referer` is **not** mandatory: requests with `Sec-Fetch-Site: same-origin` or `none` and no `Origin` are accepted, and so are requests with **no** `Origin`, `Referer` or `Sec-Fetch-Site` at all (curl, scripts), since they are not subject to cross-site request forgery; all of them are still rate limited.
- **DNS rebinding**: these checks do **not** prevent DNS rebinding in production. `ALLOWED_HOSTS` is a **development-only** setting (it is passed to the dev server's `allowedHosts`) and the production server (`bun run start`) does not enforce a hostname allowlist. If the viewer is reachable by anything you do not trust, restrict it at the network level (bind to `127.0.0.1` or a specific interface with `--host`, firewall the port) and/or put it behind a reverse proxy that rejects unexpected `Host` names.
- **Cookies**: the folder-unlock cookie is a session cookie (no expiry). It is marked `Secure` automatically on HTTPS requests; plain-HTTP LAN access is unaffected. Behind a TLS-terminating proxy (the app only sees HTTP) set `COOKIE_SECURE=true`; set `COOKIE_SECURE=false` to never add the attribute. Leave it unset for plain-HTTP LAN use. `X-Forwarded-Proto` is not trusted.
- Lock metadata that failed to load is retried at most every few seconds instead of on every request, and a library with no folders is initialized once, not rescanned on every metadata request.
## Notes

- Ensure your library path is accessible by the application.

## License

Apache License 2.0
