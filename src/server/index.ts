import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startServer } from './server';

export { startServer, type RunningServer, type ServerOptions } from './server';

function runDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main() {
  const srv = await startServer({
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST || undefined,
    dataDir: process.env.DATA_DIR,
    staticDir: process.env.STATIC_DIR,
  });
  console.log(`Carry Crew server listening on :${srv.port}`);
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) process.exit(1); // second signal: don't wait
    stopping = true;
    console.log(`${sig}: flushing data and shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    srv.close().then(
      () => process.exit(0),
      (e) => {
        console.error(e);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (runDirectly()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
