import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Runs the /api handlers the way Vercel actually runs them.
 *
 * Vercel does not bundle: it transpiles each .ts file on its own and runs the
 * result as Node ESM. That is a much stricter environment than Vite or vitest —
 * extensionless relative imports do not resolve, and a JSON import needs its type
 * attribute. Both worked everywhere in development and took the deployed
 * functions down with FUNCTION_INVOCATION_FAILED, which the client could only
 * read as "there is no API here".
 *
 * So this reproduces that environment locally: per-file transpile, no bundler,
 * plain node. It runs in CI-less form as `npm run check:serverless`.
 */

const ROOT = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'serverless-check-'));

/**
 * Run against the in-memory store, never a real one.
 *
 * On Vercel the build step is handed the project's live KV credentials, so this
 * check — which imports the handlers in-process — was talking to production
 * Redis. That made a build fail for reasons that had nothing to do with what it
 * tests (an Upstash read-after-write can come back empty, and the joined room
 * then has no seat), and it wrote a junk room into the real store on every
 * single deploy. What this script is for is proving the modules load and the
 * handlers answer under plain Node ESM; the store is not part of that.
 */
for (const key of [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
]) {
  delete process.env[key];
}
// The store also finds a prefixed pair by shape, so clear anything matching that.
for (const key of Object.keys(process.env)) {
  if (/REST_API_URL$|REDIS_REST_URL$|REST_API_TOKEN$|REDIS_REST_TOKEN$/.test(key)) {
    delete process.env[key];
  }
}

try {
  // Same layout Vercel ships: the traced sources, compiled in place.
  for (const dir of ['api', 'src', 'data']) {
    cpSync(join(ROOT, dir), join(work, dir), { recursive: true });
  }
  execFileSync(
    'npx',
    [
      'esbuild',
      `${work}/api/*.ts`,
      `${work}/src/**/*.ts`,
      '--outdir=' + work,
      '--outbase=' + work,
      '--platform=node',
      '--format=esm',
      '--target=node20',
      // No --bundle, on purpose: one file in, one file out.
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const res = () => {
    const out = { code: 0, body: undefined };
    const shim = {
      status(c) {
        out.code = c;
        return shim;
      },
      json(b) {
        out.body = b;
      },
      setHeader() {},
    };
    return { shim, out };
  };

  const failures = [];

  for (const route of ['health', 'game']) {
    const file = join(work, 'api', `${route}.js`);
    if (!existsSync(file)) {
      failures.push(`api/${route}.js was not produced`);
      continue;
    }
    let handler;
    try {
      ({ default: handler } = await import(pathToFileURL(file).href));
    } catch (e) {
      failures.push(`api/${route} could not be loaded as Node ESM:\n    ${e.message}`);
      continue;
    }
    const { shim, out } = res();
    try {
      await handler(
        route === 'health'
          ? {}
          : // A fresh code per run. The store is in-memory now so nothing can be
            // left over, but a unique code keeps a re-run inside one process
            // from tripping over its own room. Codes are truncated to 12 chars
            // server-side, so base36 keeps it inside that budget.
            {
              method: 'POST',
              body: {
                room: `C${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
                name: 'probe',
              },
            },
        shim,
      );
    } catch (e) {
      failures.push(`api/${route} threw when called: ${e.message}`);
      continue;
    }
    // health answers 200 even when unhealthy, so check the payload, not the code.
    if (route === 'health' && out.body?.ok !== true) {
      failures.push(`api/health reported itself unhealthy: ${out.body?.error ?? '(no reason)'}`);
    }
    if (route === 'game' && !out.body?.seat) {
      failures.push(
        `api/game did not seat a player (status ${out.code}): ${JSON.stringify(out.body)}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('The API would not run on Vercel:\n');
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      '\nRelative imports reachable from api/ need explicit .js extensions, and JSON\nimports need `with { type: \'json\' }`. Node ESM resolves neither on its own.',
    );
    process.exit(1);
  }
  console.log('The API loads and answers under a plain Node ESM runtime, as on Vercel.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
