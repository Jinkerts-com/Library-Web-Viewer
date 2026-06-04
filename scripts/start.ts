const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help') {
        console.log(`Usage: bun run start -- [--host <address>] [--port <port>]

Options:
  --host, --hostname  Address to bind to. Defaults to HOST or 0.0.0.0.
  --port              Port to listen on. Defaults to PORT or 4321.

Examples:
  bun run start
  bun run start -- --host 127.0.0.1
  bun run start -- --host 192.168.1.50 --port 8080`);
        process.exit(0);
    }

    if (arg === '--host' || arg === '--hostname') {
        const value = args[i + 1];
        if (!value || value.startsWith('-')) {
            console.error(`${arg} requires a value.`);
            process.exit(1);
        }
        process.env.HOST = value;
        i++;
        continue;
    }

    if (arg.startsWith('--host=')) {
        process.env.HOST = arg.slice('--host='.length);
        continue;
    }

    if (arg.startsWith('--hostname=')) {
        process.env.HOST = arg.slice('--hostname='.length);
        continue;
    }

    if (arg === '--port') {
        const value = args[i + 1];
        if (!value || value.startsWith('-')) {
            console.error('--port requires a value.');
            process.exit(1);
        }
        process.env.PORT = value;
        i++;
        continue;
    }

    if (arg.startsWith('--port=')) {
        process.env.PORT = arg.slice('--port='.length);
    }
}

process.env.HOST ||= '0.0.0.0';
process.env.PORT ||= '4321';

await import('../dist/server/entry.mjs');
