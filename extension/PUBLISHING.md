# Publishing the Lacuna VS Code Extension

This guide covers packaging and publishing `lacuna-vscode` to the **Visual Studio Marketplace**
(VS Code, Cursor via MS auth) and **Open VSX** (Cursor / Windsurf / VSCodium / Antigravity-family).

> The extension bundles the lacuna core from `../dist/index.js` at build time (esbuild), so the
> published `.vsix` is fully self-contained — it does **not** depend on the `lacuna-cli` npm package
> being installed on the user's machine.

---

## 0. Pre-flight checklist

Do these once before your first publish:

- [x] **Set the `publisher` field** in `package.json`. It currently reads `"publisher": "lacuna"` —
      change it to the publisher ID you create in step 1. Publishing fails if this doesn't match a
      publisher you own.
- [x] **Bump `version`** in `package.json` if needed (starts at `0.1.0`). Marketplace rejects
      re-publishing an existing version.
- [x] **Gallery icon** — done. `media/icon.png` (128×128) is wired via `"icon"` in `package.json`.
      (`media/lacuna.svg` is the separate, monochrome Activity-Bar icon.) To change the logo, edit
      `media/icon.svg` and re-rasterize: `sips -s format png media/icon.svg --out media/icon.png
      --resampleHeightWidth 128 128`.
- [ ] **Confirm the core is built:** `npm run build` in the repo root produces `dist/`, which the
      extension bundles from.

---

## 1. Build & sanity-check locally

```bash
cd extension
npm install          # dev tooling: esbuild, typescript, @types/*
npm run typecheck    # tsc --noEmit — must be clean
npm run build        # esbuild → out/extension.js (+ copies lacuna.schema.json)
```

Then smoke-test in an Extension Development Host: open the `extension/` folder in VS Code and press
**F5**. In the second window, open a real Jest/Vitest project, set an API key
(**Lacuna: Set API Key**), and run **Generate Tests** on a source file. Confirm the confirmation
surface → progress panel → diff flow works end-to-end with a real model call. **This is the one
path automated tests cannot cover** — do it before every release.

---

## 2. Package a `.vsix` (test the exact artifact)

Install the packaging CLI (the modern package is `@vscode/vsce`, not the deprecated `vsce`):

```bash
npm install -g @vscode/vsce
```

Build the installable bundle:

```bash
cd extension
npm run build
vsce package --no-dependencies
```

- `--no-dependencies` is intentional: esbuild already bundled everything into `out/extension.js`,
  so `node_modules` must **not** be packed. (It's wired into the `package` script too:
  `npm run package`.)
- Output: `lacuna-vscode-<version>.vsix`.

**Install the `.vsix` locally** to test the real artifact (not just the F5 dev build):

```bash
code --install-extension lacuna-vscode-<version>.vsix
```

Or: Extensions view → `...` menu → **Install from VSIX…**. Verify commands, sidebars, and a live
run all work, then uninstall before continuing.

---

## 3. Publish to the Visual Studio Marketplace

### 3a. Create a publisher (one-time)

1. Go to <https://marketplace.visualstudio.com/manage> and sign in with a Microsoft account.
2. Create a **publisher** and choose an ID (e.g. `simon-ugorji`).
3. Put that ID in `package.json`'s `publisher` field (pre-flight checklist).

### 3b. Create a Personal Access Token (one-time)

> ⚠️ **PATs are being retired on December 1, 2026.** After that, publishing needs **Microsoft Entra
> ID** ("secure automated publishing"). Until then a PAT still works. If you're setting this up for
> CI/CD or want to be future-proof, skip to **3b-alt** below. For a one-off manual publish now, the
> PAT flow is fine.

The VS Code Marketplace runs on **Azure DevOps**, so this is where the token lives — that's why
<https://aex.dev.azure.com> shows the "DevOps" product; that's expected, not a wrong turn.

1. Go to <https://aex.dev.azure.com> and sign in with the same Microsoft account.
2. **If you have no Azure DevOps organization yet, create one first** — dev.azure.com will prompt
   you (or use [Create an organization](https://learn.microsoft.com/azure/devops/organizations/accounts/create-organization)).
   This is the step most people miss: without an org, there's no **Personal Access Tokens** menu.
3. Once inside your org: **User settings** (top-right, next to your avatar) → **Personal Access
   Tokens** → **New Token**.
4. Set:
   - **Organization:** *All accessible organizations* (important — a single-org token fails to publish).
   - **Scopes:** *Custom defined* → scroll to **Marketplace** → check **Manage**.
5. Copy the token now — it's shown only once.

### 3b-alt. Secure automated publishing (Microsoft Entra ID) — the future-proof path

Microsoft now recommends **Microsoft Entra ID + workload identity federation** instead of PATs — no
long-lived secret to rotate, and it's the only option once PATs retire (Dec 1, 2026). It's aimed at
CI/CD pipelines. Follow the official guide: **[Secure automated publishing to Visual Studio
Marketplace](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing)**.
For a single manual release today, the PAT flow (3b) is simpler; adopt Entra ID when you automate
releases or before the retirement date.

### 3c. Log in and publish

```bash
vsce login <your-publisher-id>     # paste the PAT when prompted
vsce publish                        # packages + uploads
```

Convenience: `vsce publish patch` (or `minor` / `major`) bumps the version in `package.json`,
commits nothing, and publishes in one step.

The listing appears at:
`https://marketplace.visualstudio.com/items?itemName=<publisher>.lacuna-vscode`
(propagation can take a few minutes).

---

## 4. Publish to Open VSX (Cursor / Windsurf / VSCodium / Antigravity)

These editors don't use the Microsoft Marketplace. Open VSX is the open registry they read.

### 4a. One-time setup

1. Sign in at <https://open-vsx.org> with **GitHub**.
2. Create an access token: avatar → **Settings → Access Tokens → Generate New Token**.
3. **Sign the Eclipse Foundation Publisher Agreement** (mandatory — publishing fails without it).
   You need an [eclipse.org account](https://accounts.eclipse.org/), and its **GitHub Username field
   must be the exact same GitHub account** you logged into open-vsx.org with.
4. **Create your namespace** — it must match the `publisher` field in `package.json`, and it must
   exist *before* the first publish:
   ```bash
   npm install -g ovsx
   ovsx create-namespace <your-publisher-id> -p <open-vsx-token>
   ```

### 4b. Publish

```bash
ovsx publish lacuna-vscode-<version>.vsix -p <open-vsx-token>
# or store the token once:  export OVSX_PAT=<open-vsx-token>  then  ovsx publish <vsix>
```

> **Verify Antigravity resolves it.** The handoff flags this as unconfirmed — after publishing to
> Open VSX, confirm the Antigravity-family editor actually installs the extension from that registry
> before assuming parity.

---

## 5. Releasing an update

1. Make your changes; if you touched core `src/`, run `npm run build` in the **repo root** first to
   refresh `dist/`.
2. `cd extension && npm run build`
3. F5 smoke test with a live run.
4. Bump `version` in `package.json` (or let `vsce publish <patch|minor|major>` do it).
5. `vsce publish` and `ovsx publish <new>.vsix -p <token>`.

Keep the two registries at the same version.

---

## 6. What ships inside the `.vsix`

Controlled by `.vscodeignore`. Included:

- `out/extension.js` — the bundled extension (core + provider SDKs inlined).
- `out/lacuna.schema.json` — powers the settings form.
- `media/lacuna.svg`, `package.json`, `README.md`, `LICENSE`.

Excluded: `src/`, `node_modules/`, sourcemaps, `tsconfig.json`, `esbuild.mjs`.

Verify with `vsce ls` (lists what would be packed) before publishing if in doubt.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing publisher name` | `publisher` field not set / doesn't match your account. |
| `401 Unauthorized` on publish | PAT expired, wrong scope, or not "all organizations". Regenerate. |
| `.vsix` is tens of MB | Expected — the provider SDKs are bundled. `--no-dependencies` keeps `node_modules` out; the bundle itself is legitimately large. |
| Settings form is empty | `out/lacuna.schema.json` missing — re-run `npm run build` (esbuild copies it). |
| Extension doesn't activate | Check the **Lacuna** Output channel and the host's Developer Tools console. Activation is gated on `workspaceContains:**/.lacuna.json` + `onStartupFinished`. |
| Icon rejected | Gallery icon must be a **PNG**, not SVG. |
