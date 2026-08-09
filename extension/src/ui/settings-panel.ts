import * as vscode from 'vscode'
import * as path from 'node:path'
import { folderFor } from '../services/config-service'
import { offerScaffoldAfterSave } from '../services/init-service'
import { detectEnvironment } from '../core'

interface JsonSchemaProp {
  type?: string | string[]
  description?: string
  enum?: string[]
  default?: unknown
  anyOf?: JsonSchemaProp[]
  items?: JsonSchemaProp
}
interface JsonSchema { properties?: Record<string, JsonSchemaProp>; $ref?: string; definitions?: Record<string, JsonSchema> }

/**
 * Phase 3 — a settings form generated from lacuna's JSON Schema (itself generated from the Zod
 * `.describe()` metadata, so descriptions/enums/defaults stay in sync with the CLI). Writes back to
 * `.lacuna.json`. The API key is deliberately NOT here — it lives in SecretStorage (see key-service).
 */
export class SettingsPanel {
  private static current: vscode.WebviewPanel | undefined

  static async show(context: vscode.ExtensionContext, firstRun = false): Promise<void> {
    const folder = folderFor()
    if (!folder) { vscode.window.showWarningMessage('Open a folder to configure Lacuna.'); return }
    const cwd = folder.uri.fsPath

    const schema = await loadSchema(context)
    // Drop meta-keys like `$schema` — they're for editor JSON validation, not user settings.
    const props = Object.fromEntries(Object.entries(flattenProps(schema)).filter(([k]) => !k.startsWith('$')))

    // (Re)paint the form from the CURRENT .lacuna.json. This MUST run every time the panel is shown,
    // not just on first create: webviews default to retainContextWhenHidden:false, so VS Code destroys
    // the DOM when the tab is hidden and reloads it from this html string on return. If the html were
    // a stale first-open snapshot (e.g. debug unchecked), the reloaded form would then write those
    // stale values back on the next Save — silently reverting toggles like `debug`. Re-reading here +
    // retainContextWhenHidden below closes that hole. The framework-aware mocks default mirrors the
    // CLI's `init` prompt so the shared mock path is pre-filled (users missed it as one empty field).
    const paint = async (panel: vscode.WebviewPanel): Promise<void> => {
      const current = await readLacunaJson(cwd)
      const srcDir = (Array.isArray(current.sourceDir) ? current.sourceDir[0] : current.sourceDir) as string | undefined
      const mocksDefault = await computeMocksDefault(cwd, srcDir ?? 'src')
      panel.webview.html = renderHtml(props, current, firstRun, mocksDefault)
    }

    // Re-invoking the command on an open panel repaints it from the latest saved config, then reveals.
    if (SettingsPanel.current) { await paint(SettingsPanel.current); SettingsPanel.current.reveal(); return }
    const panel = vscode.window.createWebviewPanel(
      'lacuna.settings', 'Lacuna Settings', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    SettingsPanel.current = panel
    panel.onDidDispose(() => { SettingsPanel.current = undefined })
    await paint(panel)

    // After a save, offer the dependency install/scaffold when the runner isn't actually installed
    // yet — NOT gated on first run. A project can have a saved .lacuna.json but no installed deps
    // (config written, npm install never run), so keying the offer off firstRun (= "no config
    // existed") skipped setup on exactly the projects that still needed it. offerScaffoldAfterSave
    // no-ops when the runner is already present, so this doesn't nag a provisioned project. Still
    // deduped to once per session so editing several fields doesn't re-prompt each save.
    let scaffoldOffered = false

    panel.webview.onDidReceiveMessage(async (m: { type: string; values?: Record<string, unknown> }) => {
      if (m.type === 'save' && m.values) {
        await writeLacunaJson(cwd, m.values, props)
        vscode.window.showInformationMessage('Lacuna: saved .lacuna.json')
        await vscode.commands.executeCommand('setContext', 'lacuna.configured', true)
        await vscode.commands.executeCommand('lacuna.gaps.refresh')
        // Repaint from the just-written file so the form shows the NORMALIZED saved state — coerced
        // booleans, and the runner auto-persisted when the select was left on "(auto-detect)" — rather
        // than the raw values the user submitted.
        await paint(panel)
        if (!scaffoldOffered) { scaffoldOffered = true; await offerScaffoldAfterSave(cwd, context.asAbsolutePath('out/scaffold.js')) }
      } else if (m.type === 'setKey') {
        await vscode.commands.executeCommand('lacuna.setApiKey')
      }
    })
  }
}

async function loadSchema(context: vscode.ExtensionContext): Promise<JsonSchema> {
  // Copied next to the bundle at build time (see esbuild.mjs).
  const uri = vscode.Uri.file(path.join(context.extensionPath, 'out', 'lacuna.schema.json'))
  try {
    const buf = await vscode.workspace.fs.readFile(uri)
    return JSON.parse(Buffer.from(buf).toString('utf8'))
  } catch {
    return {}
  }
}

// The generated schema may be a $ref to definitions; flatten to the top-level property map.
function flattenProps(schema: JsonSchema): Record<string, JsonSchemaProp> {
  if (schema.properties) return schema.properties
  if (schema.$ref && schema.definitions) {
    const name = schema.$ref.split('/').pop()!
    return schema.definitions[name]?.properties ?? {}
  }
  if (schema.definitions) {
    const first = Object.values(schema.definitions)[0]
    return first?.properties ?? {}
  }
  return {}
}

async function readLacunaJson(cwd: string): Promise<Record<string, unknown>> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, '.lacuna.json')))
    return JSON.parse(Buffer.from(buf).toString('utf8'))
  } catch { return {} }
}

async function writeLacunaJson(cwd: string, values: Record<string, unknown>, props: Record<string, JsonSchemaProp>): Promise<void> {
  const existing = await readLacunaJson(cwd)
  const out: Record<string, unknown> = { ...existing }
  for (const [key, raw] of Object.entries(values)) {
    // mocksFile is anyOf<string|array>: accept a comma-separated list (matching its description +
    // the CLI), storing a single string for one path or an array for several. The generic json
    // coerce would otherwise JSON.parse a bare path and mangle a multi-path list.
    if (key === 'mocksFile') {
      const paths = String(raw).split(',').map((s) => s.trim()).filter(Boolean)
      if (paths.length === 0) { delete out[key]; continue }
      out[key] = paths.length > 1 ? paths : paths[0]
      continue
    }
    const prop = props[key]
    const coerced = coerce(raw, prop)
    if (coerced === undefined || coerced === '' || coerced === null) { delete out[key]; continue }
    out[key] = coerced
  }
  // Persist a concrete runner even when the form was left on "(auto-detect)" (which writes no
  // testRunner). Resolve it the same way the scaffold does — detect from the project, fall back to
  // vitest for a JS/TS project — so .lacuna.json is self-describing for the whole generate/fix
  // pipeline (which reads config.testRunner), not just the scaffold. Only fill it when absent; an
  // explicit choice is never overwritten. Non-Node/undetectable projects stay unset (no npm runner
  // to name) — the CLI falls back to its own default there.
  if (out.testRunner === undefined) {
    const resolved = await resolveTestRunner(cwd)
    if (resolved) out.testRunner = resolved
  }
  const uri = vscode.Uri.file(path.join(cwd, '.lacuna.json'))
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8'))
}

// Resolve the runner to persist when the form left it on auto-detect. Returns a concrete runner for
// a Node project (detected, or vitest as the JS/TS default), or undefined when there's no Node
// project to name one for (no package.json / a non-Node stack) — matching the scaffold's logic so
// the two never disagree.
async function resolveTestRunner(cwd: string): Promise<string | undefined> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(cwd, 'package.json')))
  } catch { return undefined } // not a Node project → let the CLI default apply
  try {
    const env = await detectEnvironment(cwd)
    if (env.testRunner !== 'unknown') return env.testRunner
  } catch { /* detection failed → fall through to the JS/TS default */ }
  return 'vitest'
}

function primaryType(prop?: JsonSchemaProp): string {
  if (!prop) return 'string'
  if (prop.enum) return 'enum'
  const t = Array.isArray(prop.type) ? prop.type.find((x) => x !== 'null') : prop.type
  if (t) return t
  if (prop.anyOf) { const s = prop.anyOf.map(primaryType); return s.includes('array') ? 'json' : s[0] ?? 'string' }
  return 'string'
}

function coerce(raw: unknown, prop?: JsonSchemaProp): unknown {
  const type = primaryType(prop)
  if (raw === undefined || raw === null) return undefined
  if (type === 'boolean') return Boolean(raw)
  if (type === 'number' || type === 'integer') { const n = Number(raw); return Number.isFinite(n) ? n : undefined }
  if (type === 'array') return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
  if (type === 'json' || type === 'object') { try { return raw === '' ? undefined : JSON.parse(String(raw)) } catch { return String(raw) } }
  return String(raw)
}

// The handful of fields worth surfacing up top on a guided setup — mirrors the CLI's `init` prompts.
// Everything else is real but rarely touched on first setup, so it goes under an Advanced section.
const PRIMARY_KEYS = ['provider', 'model', 'testRunner', 'sourceDir', 'threshold', 'mocksFile', 'setupFile']

// Friendlier labels for the guided fields (advanced fields keep their raw schema key).
const FIELD_LABEL: Record<string, string> = {
  provider: 'Provider', model: 'Model', testRunner: 'Test runner', sourceDir: 'Source directory',
  threshold: 'Coverage threshold (%)', mocksFile: 'Shared mock file', setupFile: 'Setup file',
}

// Test-runner support tiers — Lacuna can run + collect coverage for all of these, but generation is
// only tuned for a handful. Grouping (instead of a flat 13-item list) makes that honest, so the
// runner picker doesn't read as "we fully support all of these".
const RUNNER_TIERS: { label: string; runners: string[] }[] = [
  { label: 'Fully supported — generation tuned', runners: ['vitest', 'jest', 'mocha'] },
  { label: 'Lighter tuning — runs + coverage, generation still improving', runners: ['pytest', 'phpunit', 'pest'] },
  { label: 'Runner only — suite runs + coverage, generation not tuned yet', runners: ['go-test', 'rspec', 'cargo-test', 'dotnet-test', 'gradle-test', 'maven-test', 'swift-test'] },
]
const RUNNER_LABEL: Record<string, string> = {
  'go-test': 'go test', 'cargo-test': 'cargo test', 'dotnet-test': 'dotnet test',
  'gradle-test': 'gradle test', 'maven-test': 'mvn test', 'swift-test': 'swift test',
  pest: 'pest (PHP)', rspec: 'rspec (Ruby)',
}

// Framework-aware default for the shared mock file, matching the CLI's `init` default.
async function computeMocksDefault(cwd: string, sourceDir: string): Promise<string> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, 'package.json')))
    const pkg = JSON.parse(Buffer.from(buf).toString('utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const all = { ...pkg.dependencies, ...pkg.devDependencies }
    if ('react-native' in all) return `${sourceDir}/test/mock.tsx`
  } catch { /* no package.json — fall through */ }
  return `${sourceDir}/test/mocks.ts`
}

function renderRunnerSelect(val: unknown): string {
  const groups = RUNNER_TIERS.map((tier) => {
    const opts = tier.runners
      .map((r) => `<option value="${r}" ${String(val) === r ? 'selected' : ''}>${escapeHtml(RUNNER_LABEL[r] ?? r)}</option>`)
      .join('')
    return `<optgroup label="${escapeHtml(tier.label)}">${opts}</optgroup>`
  }).join('')
  const auto = `<option value="" ${val == null || val === '' ? 'selected' : ''}>(auto-detect)</option>`
  return `<select data-key="testRunner" data-type="enum">${auto}${groups}</select>`
}

function renderField(key: string, prop: JsonSchemaProp, current: Record<string, unknown>, mocksDefault: string, label: string): string {
  const type = primaryType(prop)
  let val = current[key] ?? prop.default
  // Pre-fill the mock path when unset so it's visible + guided (the user can clear it to opt out).
  if (key === 'mocksFile' && (val == null || val === '')) val = mocksDefault
  const desc = escapeHtml(prop.description ?? '')
  let input = ''
  if (key === 'testRunner') {
    input = renderRunnerSelect(val)
  } else if (type === 'boolean') {
    input = `<input type="checkbox" data-key="${key}" data-type="boolean" ${val ? 'checked' : ''}>`
  } else if (type === 'enum') {
    input = `<select data-key="${key}" data-type="enum">${['', ...(prop.enum ?? [])].map((o) => `<option ${String(val) === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>`
  } else if (type === 'number' || type === 'integer') {
    input = `<input type="number" data-key="${key}" data-type="number" value="${val ?? ''}">`
  } else if (type === 'array') {
    input = `<input type="text" data-key="${key}" data-type="array" value="${escapeHtml(Array.isArray(val) ? val.join(', ') : '')}" placeholder="comma,separated">`
  } else if (type === 'json' || type === 'object') {
    // mocksFile is anyOf<string|array> → rendered json; keep it a plain text box so the default shows.
    const shown = key === 'mocksFile' ? (typeof val === 'string' ? val : Array.isArray(val) ? (val as string[]).join(', ') : '') : (val ? JSON.stringify(val) : '')
    input = key === 'mocksFile'
      ? `<input type="text" data-key="${key}" data-type="string" value="${escapeHtml(shown)}" placeholder="${escapeHtml(mocksDefault)}">`
      : `<textarea data-key="${key}" data-type="json" rows="2" placeholder="JSON">${escapeHtml(shown)}</textarea>`
  } else {
    input = `<input type="text" data-key="${key}" data-type="string" value="${escapeHtml(val == null ? '' : String(val))}">`
  }
  return `<div class="field"><label>${escapeHtml(label)}</label><div class="control">${input}</div><p class="desc">${desc}</p></div>`
}

function renderHtml(props: Record<string, JsonSchemaProp>, current: Record<string, unknown>, firstRun: boolean, mocksDefault: string): string {
  const nonce = String(Math.random()).slice(2)
  const allKeys = Object.keys(props)
  const primary = PRIMARY_KEYS.filter((k) => k in props)
  const advanced = allKeys.filter((k) => !primary.includes(k))
  const primaryRows = primary.map((k) => renderField(k, props[k], current, mocksDefault, FIELD_LABEL[k] ?? k)).join('')
  const advancedRows = advanced.map((k) => renderField(k, props[k], current, mocksDefault, k)).join('')

  return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }
  h1 { font-size: 16px; } .intro { color: var(--vscode-descriptionForeground); }
  .field { margin: 14px 0; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  label { font-weight: 600; display: inline-block; min-width: 160px; vertical-align: top; }
  .control { display: inline-block; }
  input[type=text], input[type=number], select, textarea { font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 3px 6px; min-width: 280px; }
  .desc { margin: 4px 0 0 164px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  details.advanced { margin-top: 18px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
  details.advanced > summary { cursor: pointer; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .bar { position: sticky; bottom: 0; background: var(--vscode-editor-background); padding: 12px 0; display: flex; gap: 10px; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
</style></head><body>
<h1>Lacuna Settings</h1>
<p class="intro">${firstRun ? 'Welcome! Configure your provider, model and test runner, set your API key, then save to create <code>.lacuna.json</code>.' : 'These write to <code>.lacuna.json</code>. Your API key is stored securely and set separately.'}</p>
${primaryRows}
${advanced.length ? `<details class="advanced"><summary>Advanced (${advanced.length} more)</summary>${advancedRows}</details>` : ''}
<div class="bar">
  <button id="save">Save .lacuna.json</button>
  <button class="secondary" id="key">Set API Key…</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('save').addEventListener('click', () => {
    const values = {};
    for (const el of document.querySelectorAll('[data-key]')) {
      const t = el.getAttribute('data-type');
      values[el.getAttribute('data-key')] = t === 'boolean' ? el.checked : el.value;
    }
    vscode.postMessage({ type: 'save', values });
  });
  document.getElementById('key').addEventListener('click', () => vscode.postMessage({ type: 'setKey' }));
</script></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
