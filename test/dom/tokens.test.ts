import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Design Tokens: tokens.css', () => {
    const tokensPath = path.resolve(__dirname, '../../src/runtime/dom/tokens.css');
    const cssContent = fs.readFileSync(tokensPath, 'utf8');

    it('defines tokens on :root', () => {
        expect(cssContent).toContain(':root {');
        expect(cssContent).toContain('--mesh-color-bg-canvas:');
        expect(cssContent).toContain('--mesh-color-bg-surface:');
        expect(cssContent).toContain('--mesh-color-primary:');
        expect(cssContent).toContain('--mesh-focus-ring:');
        expect(cssContent).toContain('--mesh-space-4:');
        expect(cssContent).toContain('--mesh-radius-md:');
        expect(cssContent).toContain('--mesh-font-sans:');
    });

    it('redefines tokens under prefers-color-scheme: dark', () => {
        expect(cssContent).toContain('@media (prefers-color-scheme: dark)');
    });

    it('redefines tokens under [data-theme="dark"] and [data-theme="light"]', () => {
        expect(cssContent).toContain('[data-theme="dark"]');
        expect(cssContent).toContain('[data-theme="light"]');
    });
});
