/**
 * Generate the browser's typed client from this example's exposure.
 *
 * The point of C3.2 in one script: this reads the *exposure list*, not a running server. There is no
 * port to reach, nothing to deploy first, and CI can therefore prove the client matches the API
 * before either has been shipped.
 *
 * It writes into mesh-web's harness, because that is who calls it. A generated client belongs with
 * its caller — the API is not the thing that needs types.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { emitClient } from '../src/index.js';
import { descriptor } from './blog.js';

const OUT = process.env['OUT'] ?? resolve(
    '/home/ubuntu/code/mesh-web/browser/generated/blog-api.ts',
);

const d = descriptor();
const source = emitClient(d, { name: 'blogApi' });

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, source);

process.stdout.write(`${OUT}\n  ${String(d.calls.length)} calls at ${d.exposure}\n`);
for (const call of d.calls) {
    const gate = call.gate.kind === 'auth' ? `auth:${call.gate.level}` : `permission:${call.gate.permission}`;
    process.stdout.write(`  ${call.method.padEnd(5)} ${call.path.padEnd(16)} ${call.key.padEnd(14)} ${gate}\n`);
}
