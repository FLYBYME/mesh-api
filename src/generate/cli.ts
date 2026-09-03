#!/usr/bin/env node
/**
 * `mesh-api-generate-client` — a descriptor file in, a typed client out.
 *
 * Reads JSON rather than importing the site's TypeScript, which is the whole reason C3.2 put the
 * exposure in the site's repository: this runs in CI, before anything is deployed, with no cluster
 * to talk to. A generator that needed a live API could not tell you the client was wrong until after
 * you had shipped it.
 *
 * Writing the descriptor is the site's job — `describeExposure(expose, { application })`, then
 * `JSON.stringify`. Two steps rather than one command that does both, because the descriptor is also
 * what CI diffs to notice that an exposure changed.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import type { ExposureDescriptor } from '../exposure/descriptor.js';
import { hashDescriptor } from '../exposure/descriptor.js';
import { emitClient } from './emit.js';

interface Args {
    readonly input: string;
    readonly output: string | undefined;
    readonly name: string | undefined;
    readonly from: string | undefined;
    readonly check: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
    let input: string | undefined;
    let output: string | undefined;
    let name: string | undefined;
    let from: string | undefined;
    let check = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        const next = (): string => {
            const value = argv[++i];
            if (value === undefined) throw new Error(`${arg} needs a value`);
            return value;
        };

        switch (arg) {
            case '--out': case '-o': output = next(); break;
            case '--name': case '-n': name = next(); break;
            case '--from': from = next(); break;
            case '--check': check = true; break;
            default:
                if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
                input = arg;
        }
    }

    if (input === undefined) throw new Error('Usage: mesh-api-generate-client <descriptor.json> [--out client.ts] [--name surfdnsApi] [--check]');
    return { input, output, name, from, check };
}

export function run(argv: readonly string[]): number {
    const args = parseArgs(argv);
    const descriptor = JSON.parse(readFileSync(args.input, 'utf8')) as ExposureDescriptor;

    // The descriptor carries its own hash. A hand-edited descriptor is the same class of problem as
    // a hand-edited client, and this is the one place that can notice.
    const recomputed = hashDescriptor(descriptor);
    if (recomputed !== descriptor.exposure) {
        process.stderr.write(
            `${args.input} has been edited: it claims ${descriptor.exposure} but hashes to ${recomputed}.\n` +
            `Regenerate it from the exposure list rather than editing it.\n`,
        );
        return 2;
    }

    const source = emitClient(descriptor, {
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.from === undefined ? {} : { from: args.from }),
    });

    if (args.output === undefined) {
        process.stdout.write(source);
        return 0;
    }

    // `--check` is what CI runs: it fails on a diff rather than writing one, so a stale client is a
    // red build rather than a surprise at run time (mesh-web spec/network.md section 6).
    if (args.check) {
        let existing: string | undefined;
        try {
            existing = readFileSync(args.output, 'utf8');
        } catch {
            existing = undefined;
        }

        if (existing !== source) {
            process.stderr.write(
                existing === undefined
                    ? `${args.output} does not exist. Run without --check to generate it.\n`
                    : `${args.output} is out of date with ${args.input}. Regenerate it.\n`,
            );
            return 1;
        }
        return 0;
    }

    writeFileSync(args.output, source);
    process.stderr.write(`${args.output} — ${String(descriptor.calls.length)} calls at ${descriptor.exposure}\n`);
    return 0;
}

// `process.argv[1]` ends with this file when run as a binary, and does not when imported by a test.
if (process.argv[1]?.endsWith('cli.js') === true) {
    process.exit(run(process.argv.slice(2)));
}
