import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { copyFile, mkdir } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

// The settings webview reads the core's generated JSON Schema (built from Zod .describe()) to
// render the form. Copy it next to the bundle so it ships in the .vsix.
await mkdir(resolve(__dirname, 'out'), { recursive: true })
await copyFile(resolve(__dirname, '../lacuna.schema.json'), resolve(__dirname, 'out/lacuna.schema.json'))
  .catch((e) => console.warn('[lacuna] could not copy schema:', e.message))

/** @type {import('esbuild').BuildOptions} */
const options = {
  // Two bundles: the VS Code extension host entry, and a standalone `scaffold` script the extension
  // runs via `node out/scaffold.js` in a terminal to install deps + scaffold test config (embeds the
  // same core, so no runtime dependency on a published lacuna-cli). Named entryPoints → out/<name>.js.
  entryPoints: {
    extension: resolve(__dirname, 'src/extension.ts'),
    scaffold: resolve(__dirname, 'src/scaffold-cli.ts'),
  },
  bundle: true,
  outdir: resolve(__dirname, 'out'),
  // VS Code loads the extension entry as CommonJS; esbuild bundles the ESM lacuna core into it.
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // `vscode` is provided by the host at runtime and must never be bundled.
  external: ['vscode'],
  // The core is consumed by the stable name `lacuna-cli`, aliased to the sibling package's built
  // ESM output. Its transitive deps (@anthropic-ai/sdk, openai, zod, cosmiconfig, chalk, …) are
  // resolved from the repo-root node_modules and bundled in, so the packaged .vsix is self-
  // contained (packaged with `vsce package --no-dependencies`).
  alias: {
    'lacuna-cli': resolve(__dirname, '../dist/index.js'),
    // The scaffold script needs ONLY the test-runner scaffolding (deps: fs/path/child_process/chalk),
    // not the whole core. Aliasing straight to the built module keeps out/scaffold.js tiny instead of
    // dragging in the provider SDKs the barrel re-exports.
    'lacuna-scaffold': resolve(__dirname, '../dist/lib/scaffold.js'),
  },
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  logLevel: 'info',
  // A couple of lacuna's deps reference import.meta.url; in a CJS bundle esbuild shims it. Keep
  // the banner so any lingering reference resolves rather than throwing at load time.
  banner: {
    js: "const { createRequire: __lacunaCreateRequire } = require('node:module'); if (typeof require === 'undefined') { globalThis.require = __lacunaCreateRequire(require('node:url').pathToFileURL(__filename)); }",
  },
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[lacuna] esbuild watching…')
} else {
  await esbuild.build(options)
  console.log('[lacuna] build complete → out/extension.js + out/scaffold.js')
}
