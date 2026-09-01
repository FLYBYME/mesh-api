import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '..', 'src');
const distDir = path.resolve(import.meta.dirname, '..', 'dist');

fs.cpSync(srcDir, distDir, {
    recursive: true,
    filter: (source) => {
        if (fs.statSync(source).isDirectory()) return true;
        return source.endsWith('.css');
    },
});
