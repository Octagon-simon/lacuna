// AST FlowMap (P2 — the linchpin from the research): map each interactive CONTROL in a page
// component to the OUTCOME its handler produces (toast / redirect / modal / service call), so an E2E
// spec asserts the RIGHT result for the action it performed — not every string in the file.
//
// Why AST, not regex: regex finds `toast.info("Redirecting…")` and `router.push("/upgrade")` but
// can't tell that they belong to the Upgrade button's handler, not the Save button's. Attributing
// every outcome to every action is exactly the regression we hit. The AST resolves
//   control (onClick={handler}) → handler body → the toast/redirect/calls INSIDE that handler.
//
// v2 adds ONE-HOP cross-file resolution: a handler that is imported (`import { handleX } from './x'`)
// or destructured from a custom hook (`const { handleSave } = useMenuActions()`) is followed into its
// defining file and its outcomes extracted there — lifting the common case where a page wires its
// controls to handlers that live in a hook. Resolution is bounded to a single hop and skips
// node_modules; a handler we still can't resolve (a component PROP whose body lives in the caller, or
// anything past one hop) stays `external` with NO invented outcome — a shallow-but-correct mapping
// beats a confident-but-wrong one. Cross-file is best-effort and only runs when the caller passes the
// entry file's absolute path; without it, behaviour is identical to v1 (single-file).
//
// Uses the TARGET PROJECT's own TypeScript (resolved from cwd, like we use its Playwright) so there's
// no heavy lacuna dependency and the parse matches the project. Self-contained (only Node builtins),
// so this module is also published standalone in /flowmap.

import { createRequire } from 'module'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'

export interface FlowOutcome {
  toast?: { message: string; kind: 'success' | 'error' | 'info' | 'warning' }
  redirect?: string
  opensModal?: boolean   // handler calls setShowX(true)/setOpen(true) — opens a panel/modal
}

export interface FlowAction {
  control: string        // best locator hint for the triggering control (text / testid / aria-label)
  by: 'testid' | 'text' | 'label'
  handler: string        // handler name, or '(inline)'
  external: boolean      // handler is a prop/import we couldn't resolve — its real outcome lives elsewhere
  resolvedFrom?: string  // when cross-file resolution succeeded: the file the handler body came from
  outcomes: FlowOutcome
  calls: string[]        // notable calls in the handler (services, other handlers) — intent, not assert
}

type TS = typeof import('typescript')
type Node = import('typescript').Node

// Resolve the PROJECT's typescript (a TS project always has it), so lacuna doesn't bundle ~60MB.
function resolveTs(cwd: string): TS | null {
  try {
    const req = createRequire(import.meta.url)
    const p = req.resolve('typescript', { paths: [cwd] })
    return req(p)
  } catch {
    try { const req = createRequire(import.meta.url); return req('typescript') } catch { return null }
  }
}

const HANDLER_ATTRS = new Set(['onClick', 'onSubmit', 'onPress', 'onChange'])

// One-hop cross-file resolution context. Built only when the caller passes the entry file path.
interface XFile {
  ts: TS
  cwd: string
  fromFileAbs: string
  aliases: Record<string, string[]>
  imports: Map<string, { module: string; imported: string }>   // local name → where it came from
  hookBindings: Map<string, string>                            // destructured name → hook call name
  cache: Map<string, import('typescript').SourceFile | null>   // parsed foreign files by abs path
}

export function buildFlowMap(sourceCode: string | null, cwd: string, sourceFileAbs?: string): FlowAction[] | null {
  if (!sourceCode) return null
  const ts = resolveTs(cwd)
  if (!ts) return null

  let sf
  try {
    sf = ts.createSourceFile('component.tsx', sourceCode, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX)
  } catch { return null }

  // 1. Index top-level handler declarations, props, imports, and hook destructures.
  const decls = new Map<string, Node>()
  const propNames = new Set<string>()   // component params/destructured props — outcome lives in the caller
  const imports = new Map<string, { module: string; imported: string }>()
  const hookBindings = new Map<string, string>()   // `const { handleSave } = useMenuActions()`
  const visitTop = (node: Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) decls.set(node.name.text, node)
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          decls.set(d.name.text, d.initializer)
        }
        // `const { handleSave, handleDelete } = useMenuActions()` → bind each name to the hook call
        if (ts.isObjectBindingPattern(d.name) && d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression)) {
          const hook = d.initializer.expression.text
          for (const el of d.name.elements) if (ts.isIdentifier(el.name)) hookBindings.set(el.name.text, hook)
        }
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause && !node.importClause.isTypeOnly) {
      const mod = node.moduleSpecifier.text
      if (node.importClause.name) imports.set(node.importClause.name.text, { module: mod, imported: 'default' })
      const nb = node.importClause.namedBindings
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) if (!e.isTypeOnly) imports.set(e.name.text, { module: mod, imported: (e.propertyName ?? e.name).text })
      }
    }
    // Destructured props at component scope: `({ onAddItem, onPrintMenu }) => …`
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) if (ts.isIdentifier(el.name)) propNames.add(el.name.text)
    }
    ts.forEachChild(node, visitTop)
  }
  visitTop(sf)

  const xfile: XFile | null = sourceFileAbs
    ? { ts, cwd, fromFileAbs: sourceFileAbs, aliases: readAliases(cwd, ts), imports, hookBindings, cache: new Map() }
    : null

  // 2. Walk JSX for handler attributes and build an action per control.
  const actions: FlowAction[] = []
  const seen = new Set<string>()

  const visit = (node: Node) => {
    if (ts.isJsxAttribute(node) && node.name && ts.isIdentifier(node.name) && HANDLER_ATTRS.has(node.name.text)) {
      const init = node.initializer
      if (init && ts.isJsxExpression(init) && init.expression) {
        const resolved = resolveHandler(init.expression, ts, decls, propNames)
        const owner = findOwnerElement(node, ts)
        const label = owner ? controlLabel(owner, ts) : null
        if (label) {
          const outcomes: FlowOutcome = {}
          const calls: string[] = []
          let { external, body } = resolved
          let resolvedFrom: string | undefined
          // v2: if local resolution failed, try one hop into a hook / imported file.
          if (!body && resolved.handler !== '(inline)' && xfile) {
            const x = resolveAcrossFiles(resolved.handler, sf, xfile)
            if (x) { body = x.body; external = false; resolvedFrom = x.file }
          }
          if (body) extractOutcomes(body, ts, outcomes, calls)
          const key = label.value + '|' + resolved.handler
          if (!seen.has(key)) {
            seen.add(key)
            actions.push({ control: label.value, by: label.by, handler: resolved.handler, external, resolvedFrom, outcomes, calls: dedupe(calls).slice(0, 6) })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return actions
}

// Resolve a handler expression: an inline arrow → its body; an identifier → the declared function's
// body (or external if it's a prop / not found in this file).
function resolveHandler(expr: Node, ts: TS, decls: Map<string, Node>, propNames: Set<string>): { handler: string; external: boolean; body: Node | null } {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return { handler: '(inline)', external: false, body: expr.body }
  if (ts.isIdentifier(expr)) {
    const name = expr.text
    const decl = decls.get(name)
    if (decl) return { handler: name, external: false, body: ts.isFunctionDeclaration(decl) ? (decl.body ?? null) : ((decl as import('typescript').ArrowFunction).body ?? null) }
    return { handler: name, external: propNames.has(name) || true, body: null }   // prop/import → maybe resolvable cross-file
  }
  // e.g. onClick={() => setActiveTab(id)} already handled; member calls (handleX.bind) → name best-effort
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return { handler: expr.expression.text, external: true, body: null }
  return { handler: '(inline)', external: false, body: ts.isArrowFunction(expr) ? expr.body : null }
}

// ── v2 cross-file resolution ────────────────────────────────────────────────────────────────────

// Try to find a handler's body one hop away: in a custom hook it's destructured from, or in the file
// it's imported from. Returns the body + the file it came from, or null.
function resolveAcrossFiles(name: string, entrySf: import('typescript').SourceFile, x: XFile): { body: Node; file: string } | null {
  const ts = x.ts
  // (a) `const { handleSave } = useMenuActions()` — resolve the hook, then the handler inside it.
  const hook = x.hookBindings.get(name)
  if (hook) {
    // The hook is usually imported; occasionally defined in this same file.
    const imp = x.imports.get(hook)
    const hookSf = imp ? loadForeign(imp.module, x) : entrySf
    if (hookSf) {
      const body = findHookHandler(hookSf, hook, name, ts)
      if (body) return { body, file: hookSf.fileName }
    }
  }
  // (b) `import { handleX } from './x'` used directly as a handler.
  const imp = x.imports.get(name)
  if (imp) {
    const foreign = loadForeign(imp.module, x)
    if (foreign) {
      const body = findTopLevelHandler(foreign, imp.imported === 'default' ? name : imp.imported, ts)
      if (body) return { body, file: foreign.fileName }
    }
  }
  return null
}

// Parse a foreign module (one hop). Only local files; node_modules and unresolvable specifiers → null.
function loadForeign(moduleSpec: string, x: XFile): import('typescript').SourceFile | null {
  const base = resolveImport(moduleSpec, x.fromFileAbs, x.cwd, x.aliases)
  if (!base) return null
  const file = resolveToFile(base)
  if (!file) return null
  if (x.cache.has(file)) return x.cache.get(file) ?? null
  let sf: import('typescript').SourceFile | null = null
  try {
    const code = readFileSync(file, 'utf-8')
    sf = x.ts.createSourceFile(file, code, x.ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? x.ts.ScriptKind.TSX : x.ts.ScriptKind.TS)
  } catch { sf = null }
  x.cache.set(file, sf)
  return sf
}

// Find a top-level `function name(){}` / `const name = () => {}` body in a file.
function findTopLevelHandler(sf: import('typescript').SourceFile, name: string, ts: TS): Node | null {
  let found: Node | null = null
  const walk = (n: Node) => {
    if (found) return
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) { found = n.body ?? null; return }
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          found = d.initializer.body; return
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return found
}

// Find a handler declared INSIDE a custom hook function (`function useX(){ const handler = ()=>{} … }`).
function findHookHandler(sf: import('typescript').SourceFile, hookName: string, handlerName: string, ts: TS): Node | null {
  const hookBody = findTopLevelHandler(sf, hookName, ts)
  if (!hookBody) return null
  let found: Node | null = null
  const walk = (n: Node) => {
    if (found) return
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === handlerName && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          found = d.initializer.body; return
        }
      }
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === handlerName) { found = n.body ?? null; return }
    ts.forEachChild(n, walk)
  }
  walk(hookBody)
  return found
}

// Read tsconfig path aliases (best-effort, sync) for import resolution.
function readAliases(cwd: string, ts: TS): Record<string, string[]> {
  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json']) {
    try {
      const raw = readFileSync(join(cwd, name), 'utf-8')
      const parsed = ts.parseConfigFileTextToJson(name, raw)
      const paths = parsed.config?.compilerOptions?.paths
      if (paths) return paths
    } catch { /* try next */ }
  }
  return {}
}

// Resolve an import specifier to an absolute base path (no extension). null for bare/node_modules.
function resolveImport(spec: string, fromFileAbs: string, cwd: string, aliases: Record<string, string[]>): string | null {
  for (const [pattern, targets] of Object.entries(aliases)) {
    const aliasPrefix = pattern.replace(/\*$/, '')
    const targetBase = (targets[0] ?? '').replace(/\*$/, '')
    if (aliasPrefix && spec.startsWith(aliasPrefix)) return join(cwd, targetBase + spec.slice(aliasPrefix.length))
    if (spec === pattern.replace(/\/\*$/, '')) return join(cwd, targets[0] ?? '')
  }
  if (spec.startsWith('.')) return join(dirname(fromFileAbs), spec)
  return null
}

function resolveToFile(base: string): string | null {
  for (const suffix of ['.ts', '.tsx', '.jsx', '.js', '/index.ts', '/index.tsx', '/index.jsx', '/index.js']) {
    if (existsSync(base + suffix)) return base + suffix
  }
  return null
}

// ── outcome extraction (unchanged from v1) ───────────────────────────────────────────────────────

// Pull toast/redirect/modal/service signals out of a handler body.
function extractOutcomes(body: Node, ts: TS, out: FlowOutcome, calls: string[]): void {
  const str = (n: Node | undefined): string | null => {
    if (!n) return null
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
    return null
  }
  const walk = (n: Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      // toast.success('x') | toast('x') | showToast('x') | enqueueSnackbar('x', {variant})
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const obj = callee.expression.text
        const method = callee.name.text
        if (/^(toast|message|notify|sonner)$/i.test(obj) && /^(success|error|info|warning|warn)$/i.test(method)) {
          const m = str(n.arguments[0])
          if (m && !out.toast) out.toast = { message: m, kind: method.toLowerCase().startsWith('warn') ? 'warning' : (method.toLowerCase() as 'success' | 'error' | 'info') }
        } else if (/^router$/.test(obj) && /^(push|replace)$/.test(method)) {
          const r = str(n.arguments[0]); if (r && !out.redirect) out.redirect = r
        } else {
          calls.push(obj + '.' + method)
        }
      } else if (ts.isIdentifier(callee)) {
        const fn = callee.text
        if (/^(toast|showToast|enqueueSnackbar|notify|addToast)$/i.test(fn)) {
          const m = str(n.arguments[0]); if (m && !out.toast) out.toast = { message: m, kind: classifyVariant(n, ts) }
        } else if (/^(navigate|redirect|push)$/.test(fn)) {
          const r = str(n.arguments[0]); if (r && !out.redirect) out.redirect = r
        } else if (/^set[A-Z]/.test(fn)) {
          // setShowX(true)/setOpen(true) → opens a panel/modal
          const a = n.arguments[0]
          if (a && a.kind === ts.SyntaxKind.TrueKeyword && /show|open|modal|dialog|drawer|panel/i.test(fn)) out.opensModal = true
        } else {
          calls.push(fn)
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(body)
}

function classifyVariant(call: import('typescript').CallExpression, ts: TS): 'success' | 'error' | 'info' | 'warning' {
  // second arg { variant: 'error' } or 'error'
  const a2 = call.arguments[1]
  if (a2) {
    const t = a2.getText()
    if (/error|warn/i.test(t)) return /warn/i.test(t) ? 'warning' : 'error'
    if (/success/i.test(t)) return 'success'
  }
  const msg = call.arguments[0] && (ts.isStringLiteral(call.arguments[0]) ? call.arguments[0].text : '')
  if (msg && /error|fail|invalid|required|wrong|denied|too\s+(weak|short)/i.test(msg)) return 'error'
  return 'info'
}

// The JSX element that owns this attribute.
function findOwnerElement(attr: Node, ts: TS): Node | null {
  let n: Node | undefined = attr.parent   // JsxAttributes
  while (n && !(ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n))) n = n.parent
  return n ?? null
}

// Best locator for the control: data-testid > visible text > aria-label.
function controlLabel(el: Node, ts: TS): { value: string; by: 'testid' | 'text' | 'label' } | null {
  const opening = ts.isJsxElement(el) ? el.openingElement : (el as import('typescript').JsxSelfClosingElement)
  const attrs = opening.attributes.properties
  const getAttr = (name: string): string | null => {
    for (const a of attrs) {
      if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name && a.initializer && ts.isStringLiteral(a.initializer)) return a.initializer.text
    }
    return null
  }
  const testid = getAttr('data-testid')
  if (testid) return { value: testid, by: 'testid' }
  if (ts.isJsxElement(el)) {
    const text = el.children.map((c) => (ts.isJsxText(c) ? c.text : '')).join(' ').replace(/\s+/g, ' ').trim()
    if (text && text.length <= 40) return { value: text, by: 'text' }
  }
  const aria = getAttr('aria-label')
  if (aria) return { value: aria, by: 'label' }
  return null
}

function dedupe(a: string[]): string[] { return [...new Set(a)] }
