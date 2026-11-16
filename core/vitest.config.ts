import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

/**
 * `.md` imports are raw text, matching the esbuild `--loader:.md=text` used for
 * the production bundle. Without this the ECC skill bundle cannot be tested.
 */
export default defineConfig({
  plugins: [
    {
      name: 'raw-markdown',
      transform(code, id) {
        if (!id.endsWith('.md')) return null;
        return { code: `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`, map: null };
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
