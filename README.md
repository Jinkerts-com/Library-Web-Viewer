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

- [Node.js](https://nodejs.org/) or [Bun](https://bun.sh/) (Recommended)

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
    image: ghcr.io/jinkert-com/library-web-viewer:latest
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
  ghcr.io/jinkert-com/library-web-viewer:latest
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

## Notes

- Ensure your library path is accessible by the application.

## License

MIT
