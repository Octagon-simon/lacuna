import * as vscode from 'vscode'
import type { RunHandle } from '../services/run-manager'
import type { HostToPanel, PanelToHost } from '../protocol'

/**
 * The progress panel IS the "terminal session," made legible (§1). A live, append-only log of
 * waiting → generating → writing → running → retrying (+ streamed phase text + learned-rules
 * used), a live stats header (requests / elapsed / pass-fail), and a Stop control. It is
 * closeable; the status-bar item outlives it (the run keeps spending), and re-opening replays.
 */
export class ProgressPanel {
  private static current: ProgressPanel | undefined
  private panel: vscode.WebviewPanel
  private sub: vscode.Disposable | undefined
  private run: RunHandle | undefined

  private constructor(private readonly output: vscode.OutputChannel) {
    this.panel = vscode.window.createWebviewPanel(
      'lacuna.progress', 'Lacuna', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel.webview.html = this.html()
    this.panel.webview.onDidReceiveMessage((m: PanelToHost) => this.onMessage(m))
    this.panel.onDidDispose(() => { this.sub?.dispose(); ProgressPanel.current = undefined })
  }

  static showFor(output: vscode.OutputChannel, run: RunHandle): ProgressPanel {
    if (!ProgressPanel.current) ProgressPanel.current = new ProgressPanel(output)
    ProgressPanel.current.bind(run)
    ProgressPanel.current.panel.reveal(vscode.ViewColumn.Beside, true)
    return ProgressPanel.current
  }

  static revealLatest(): boolean {
    if (ProgressPanel.current) { ProgressPanel.current.panel.reveal(); return true }
    return false
  }

  private bind(run: RunHandle) {
    this.sub?.dispose()
    this.run = run
    this.panel.title = `Lacuna: ${run.title}`
    // Reconstruct init from the run's metadata (correct even when the panel opens after the run
    // started, or is reopened later), then replay the buffered transcript and live-stream.
    this.post({ type: 'init', title: run.title, model: run.meta.model, provider: run.meta.provider, maxIterations: run.meta.maxIterations, files: run.files })
    for (const text of run.rawLog) this.post({ type: 'log', line: { kind: 'info', text, ts: Date.now() } })
    this.post({ type: 'stats', stats: { ...run.stats } })
    this.sub = run.onMessage((m) => this.post(m))
  }

  private onMessage(m: PanelToHost) {
    if (m.type === 'viewRawLog') this.output.show(true)
    else if (m.type === 'cancel' && this.run) {
      this.run.requestCancel()
      vscode.window.setStatusBarMessage('Lacuna: stopping after the in-flight file(s)…', 4000)
    }
  }

  private post(m: HostToPanel) { void this.panel.webview.postMessage(m) }

  private html(): string {
    const nonce = String(Math.random()).slice(2)
    const csp = this.panel.webview.cspSource
    return /* html */ `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; font-size: 13px; }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  .title { font-weight: 600; font-size: 14px; }
  .stats { display: flex; gap: 16px; margin-top: 6px; color: var(--vscode-descriptionForeground); flex-wrap: wrap; }
  .stats b { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
  .bar { height: 4px; background: var(--vscode-progressBar-background); opacity: .25; border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--vscode-progressBar-background); opacity: 1; width: 0; transition: width .3s; }
  .actions { margin-top: 8px; display: flex; gap: 8px; }
  button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
  button.stop { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { opacity: .85; }
  #log { padding: 8px 14px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.6; }
  .row { display: flex; gap: 8px; white-space: pre-wrap; word-break: break-word; }
  .row .file { color: var(--vscode-textLink-foreground); }
  .row.phase .msg { color: var(--vscode-descriptionForeground); }
  .row.success .msg { color: var(--vscode-testing-iconPassed, #3fb950); }
  .row.error .msg { color: var(--vscode-testing-iconFailed, #f85149); }
  .row.warn .msg { color: var(--vscode-editorWarning-foreground, #d29922); }
  .row.memory .msg { color: var(--vscode-charts-purple, #a371f7); }
  .row.token .msg { color: var(--vscode-descriptionForeground); opacity: .8; }
  .done { margin: 12px 14px; padding: 10px 12px; border-radius: 6px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); }
</style></head><body>
<header>
  <div class="title" id="title">Lacuna</div>
  <div class="stats">
    <span>Model: <b id="model">—</b></span>
    <span>Requests: <b id="requests">0</b></span>
    <span>Elapsed: <b id="elapsed">0s</b></span>
    <span>Files: <b id="files">0/0</b></span>
    <span>✓ <b id="passed">0</b> · ✗ <b id="failed">0</b></span>
  </div>
  <div class="bar"><div id="prog"></div></div>
  <div class="actions">
    <button class="stop" id="stop">Stop</button>
    <button id="raw">View Raw Log</button>
  </div>
</header>
<div id="log"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  let done = false;
  function esc(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
  function addRow(line){
    const div = document.createElement('div');
    div.className = 'row ' + (line.kind||'info');
    const file = line.file ? '<span class="file">'+esc(shorten(line.file))+'</span>' : '';
    div.innerHTML = file + '<span class="msg">'+esc(line.text)+'</span>';
    log.appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
  }
  function shorten(p){ const a=p.split('/'); return a.length>2 ? '…/'+a.slice(-2).join('/') : p; }
  function fmt(ms){ const s=Math.round(ms/1000); return s<60 ? s+'s' : Math.floor(s/60)+'m '+(s%60)+'s'; }
  function setStats(st){
    $('requests').textContent = st.requests;
    $('elapsed').textContent = fmt(st.elapsedMs);
    $('files').textContent = st.filesDone+'/'+st.filesTotal;
    $('passed').textContent = st.passed;
    $('failed').textContent = st.failed;
    const pct = st.filesTotal ? Math.round(100*st.filesDone/st.filesTotal) : 0;
    $('prog').style.width = pct+'%';
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init'){ $('title').textContent = m.title; if(m.model) $('model').textContent = m.model+' ('+m.provider+')'; if(!m._replay){ log.innerHTML=''; done=false; } }
    else if (m.type === 'log'){ addRow(m.line); }
    else if (m.type === 'stats'){ setStats(m.stats); }
    else if (m.type === 'done'){ done=true; setStats(m.stats); const d=document.createElement('div'); d.className='done'; d.textContent=(m.ok?'✓ ':'✗ ')+m.summary; log.appendChild(d); $('stop').disabled=true; window.scrollTo(0,document.body.scrollHeight); }
  });
  $('stop').addEventListener('click', () => { if(!done){ vscode.postMessage({type:'cancel'}); $('stop').textContent='Stopping…'; $('stop').disabled=true; } });
  $('raw').addEventListener('click', () => vscode.postMessage({type:'viewRawLog'}));
  vscode.postMessage({type:'ready'});
</script></body></html>`
  }

  dispose() { this.sub?.dispose(); this.panel.dispose() }
}
