import { defineConfig } from 'vitest/config';

// Deliberately minimal. An earlier version set `environmentMatchGlobs` to route `test/dom/**` to
// happy-dom -- but Vitest 4 removed that option, so it was dead config that read as if it were
// doing the work. The DOM suites actually get their environment from a
// `// @vitest-environment happy-dom` docblock at the top of each file, which is Vitest 4's
// mechanism and has the advantage of being visible in the file it applies to.
export default defineConfig({
    test: {},
});
