// Standalone scaffold entry, bundled by esbuild to out/scaffold.js and run as
//   node out/scaffold.js --runner <runner> --source-dir <dir>
// in an integrated terminal. Installs the test runner + testing-library deps and scaffolds runner
// config / setup files for the workspace, streaming npm-install progress to the terminal. Does NOT
// touch .lacuna.json (the extension's settings panel owns that).
//
// This is what lets the extension ship independently of the published `lacuna-cli`: the scaffold
// logic is bundled from the SAME core the extension embeds, so there is no runtime dependency on
// npm/npx and no cross-package version coupling — setup works offline and always matches the build.
// Import straight from the scaffold module (aliased in esbuild.mjs), NOT the `lacuna-cli` barrel —
// the barrel re-exports the agentic loops + provider SDKs, which would bloat this bundle ~200x.
import { scaffoldProject, findProjectRoot } from 'lacuna-scaffold'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  // --runner is optional: omitted (the settings panel's "(auto-detect)" case, which writes no
  // testRunner to .lacuna.json) means scaffoldProject detects the runner and falls back to vitest.
  const runner = arg('runner')
  const sourceDir = arg('source-dir') ?? 'src'
  const setupFile = arg('setup-file')
  const cwd = await findProjectRoot(process.cwd())
  await scaffoldProject({ cwd, runner, sourceDir, setupFile, log: (m: string) => console.log(m) })
  console.log('\n✓ Setup complete. You can close this terminal and generate tests.')
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
