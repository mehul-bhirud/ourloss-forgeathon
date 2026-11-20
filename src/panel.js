'use strict';

const { randomBytes } = require('node:crypto');

const script = String.raw`
const vscode = acquireVsCodeApi();
const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'status', 'progress', 'composer', 'new-request', 'new-label', 'instruction', 'request', 'run',
  'activity', 'activity-list', 'activity-label', 'transcript', 'transcript-text', 'context',
  'context-list', 'context-budget', 'session', 'model', 'retry', 'models', 'cancel', 'review',
  'review-label', 'files', 'apply', 'reject', 'rehearse', 'revise', 'receipt', 'verification',
  'save', 'undo'
].map((id) => [id, byId(id)]));
let snapshot;
let selected = new Set();
let reviewReady = false;
let working = false;
let rehearsing = false;
let latestReceipt;
let activityCount = 0;
let lastActivity;

function element(tag, text = '', className) {
  const item = document.createElement(tag);
  item.textContent = text;
  if (className) item.className = className;
  return item;
}

function send(type, data = {}) {
  vscode.postMessage({ type, ...data });
}

function setStep(step) {
  ui.progress.hidden = false;
  const order = ['inspect', 'review', 'apply', 'complete'];
  for (const item of ui.progress.children) {
    const phase = item.dataset.step;
    const comparison = order.indexOf(step) - order.indexOf(phase);
    item.dataset.state = comparison === 0 ? 'current' : comparison > 0 ? 'done' : 'waiting';
    if (comparison === 0) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
}

function setStatus(text, error = false) {
  ui.status.dataset.tone = error ? 'error' : '';
  ui.status.textContent = text;
}

function stopProgress() {
  const current = ui.progress.querySelector('[aria-current]');
  if (!current) return;
  current.dataset.state = 'stopped';
  current.removeAttribute('aria-current');
}

function log(title, detail) {
  if (lastActivity?.title === title && lastActivity.detail === detail) return;
  lastActivity = { title, detail };
  const item = element('li');
  item.append(element('strong', title));
  if (detail) item.append(element('div', detail, 'subtle'));
  ui['activity-list'].prepend(item);
  if (ui['activity-list'].childElementCount > 70) ui['activity-list'].lastElementChild.remove();
  ui['activity-label'].textContent = 'Run activity (' + ++activityCount + ')';
  ui.activity.hidden = false;
}

function refreshControls() {
  const total = snapshot?.files.reduce((sum, file) => sum + file.hunks.length, 0) ?? 0;
  const canEditReview = reviewReady && !rehearsing;
  const canApply = canEditReview && selected.size > 0;
  ui.apply.disabled = !canApply;
  ui.rehearse.disabled = !canApply;
  ui.reject.disabled = !canEditReview;
  ui.revise.disabled = !canEditReview;
  ui.cancel.disabled = !working;
  ui.run.disabled = working;
  ui.models.disabled = working;
  ui.apply.textContent = selected.size ? 'Apply ' + selected.size + (selected.size === 1 ? ' hunk' : ' hunks') : 'Apply selected';
  ui['review-label'].textContent = selected.size + ' of ' + total + ' selected';
}

function renderDraft(next, ready) {
  const previousIds = new Set(snapshot?.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)) ?? []);
  const nextIds = next.files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
  const changedDraft = next.digest !== snapshot?.digest;
  selected = new Set(nextIds.filter((id) => selected.has(id) || !previousIds.has(id)));
  snapshot = next;
  reviewReady = ready;
  if (changedDraft || !ready) {
    ui.receipt.hidden = true;
    latestReceipt = undefined;
  }
  ui.files.replaceChildren();
  ui.review.hidden = !next.files.length;
  if (next.files.length) setStep(ready ? 'review' : 'inspect');
  for (const file of next.files) {
    const group = element('section', '', 'file');
    const open = element('button', file.path, 'file-link');
    open.type = 'button';
    open.title = 'Open diff for ' + file.path;
    open.addEventListener('click', () => send('preview', { path: file.path, hunkIds: [...selected] }));
    const checks = element('div', '', 'hunks');
    for (const hunk of file.hunks) {
      const label = element('label', '', 'hunk');
      const choice = document.createElement('input');
      choice.type = 'checkbox';
      choice.checked = selected.has(hunk.id);
      choice.value = hunk.id;
      choice.disabled = !ready;
      const lineLabel = hunk.oldEnd > hunk.oldStart ? hunk.oldStart + '–' + hunk.oldEnd : String(hunk.oldStart);
      choice.setAttribute('aria-label', file.path + ', line ' + lineLabel);
      choice.addEventListener('change', () => {
        if (choice.checked) selected.add(hunk.id);
        else selected.delete(hunk.id);
        if (!ui.receipt.hidden) {
          ui.receipt.replaceChildren(element('div', 'Selection changed. Verify these hunks again.', 'subtle'));
        }
        latestReceipt = undefined;
        refreshControls();
      });
      label.append(choice, element('span', 'L' + lineLabel));
      checks.append(label);
    }
    group.append(open, checks);
    ui.files.append(group);
  }
}

function contextEntry(entry) {
  const disclosure = document.createElement('details');
  const summary = document.createElement('summary');
  const file = element('code', entry.path);
  const range = element('span', 'L' + entry.start + '–' + entry.end, 'line-range');
  const reason = element('span', entry.reason, 'context-reason');
  summary.append(file, range, reason);
  disclosure.append(summary, element('pre', entry.excerpt));
  return disclosure;
}

function renderContext(event) {
  const entries = event.entries ?? [];
  const seen = new Set();
  const primary = [];
  const extra = [];
  for (const entry of entries) {
    if (primary.length < 3 && !seen.has(entry.path)) {
      seen.add(entry.path);
      primary.push(entry);
    } else {
      extra.push(entry);
    }
  }
  ui['context-list'].replaceChildren(...primary.map(contextEntry));
  if (extra.length) {
    const disclosure = element('details', '', 'context-more');
    disclosure.append(element('summary', extra.length + ' more excerpts'), ...extra.map(contextEntry));
    ui['context-list'].append(disclosure);
  }
  ui['context-budget'].textContent = event.bytes + ' / ' + event.budget + ' bytes';
  ui.context.hidden = false;
}

function verdict(label, result) {
  const card = element('div', '', 'verdict');
  card.dataset.result = result.status;
  const heading = element('div', '', 'verdict-heading');
  heading.append(element('strong', label), element('span', result.status, 'result'));
  card.append(heading);
  if (result.output) card.append(element('div', result.output.slice(0, 500), 'verdict-output'));
  return card;
}

function renderReceipt(event) {
  const heading = element('div', '', 'receipt-heading');
  const evidence = String(event.evidenceId ?? event.digest ?? '');
  const marker = element('code', evidence.slice(0, 12), 'evidence-id');
  marker.title = evidence;
  heading.append(element('strong', event.check.label), marker);
  const grid = element('div', '', 'verdicts');
  grid.append(verdict('Baseline', event.baseline), verdict('Selected hunks', event.candidate));
  ui.receipt.replaceChildren(heading, grid);
  ui.receipt.hidden = false;
}

function begin(event) {
  working = true;
  reviewReady = false;
  rehearsing = false;
  selected = new Set();
  snapshot = undefined;
  latestReceipt = undefined;
  activityCount = 0;
  lastActivity = undefined;
  ui.session.disabled = true;
  ui.activity.hidden = true;
  ui.activity.open = true;
  ui['activity-list'].replaceChildren();
  ui.transcript.hidden = true;
  ui.transcript.open = false;
  ui['transcript-text'].textContent = '';
  for (const id of ['review', 'receipt', 'context', 'verification', 'model', 'retry', 'new-request']) ui[id].hidden = true;
  if (event.mode === 'workspace') ui.instruction.value = event.instruction;
  ui.request.textContent = event.instruction;
  ui.request.hidden = false;
  ui.cancel.hidden = false;
  setStep('inspect');
  setStatus(event.mode === 'inline' ? 'Reading selection' : 'Finding workspace context');
}

ui.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = ui.instruction.value.trim();
  if (value && !working) send('run', { instruction: value });
});
ui.instruction.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!working) ui.composer.requestSubmit();
  }
});
ui.cancel.onclick = () => send('cancel');
ui.models.onclick = () => send('models');
ui.session.onclick = () => send('session');
ui.save.onclick = () => send('save');
ui.undo.onclick = () => send('undo');
ui.apply.onclick = () => send('decide', { digest: snapshot.digest, hunkIds: [...selected] });
ui.reject.onclick = () => send('decide', { digest: snapshot.digest, hunkIds: [] });
ui.rehearse.onclick = () => send('rehearse', { digest: snapshot.digest, hunkIds: [...selected] });
ui.revise.onclick = () => send('revise', { digest: snapshot.digest, feedback: latestReceipt?.candidate.output });

window.addEventListener('message', ({ data: event }) => {
  if (event.type === 'begin') begin(event);
  if (event.type === 'status') {
    setStatus(event.text, event.error);
    if (event.text === 'Applying approved hunks') setStep('apply');
  }
  if (event.type === 'session') {
    ui.session.disabled = false;
    ui.model.hidden = false;
    ui.model.textContent = event.model;
    ui.model.title = 'TrueForge session ' + event.id;
    log('TrueForge session', event.model + ' · ' + event.id);
  }
  if (event.type === 'log') {
    log(event.title, event.detail);
    if (['Retrying after backoff', 'Switching configured model', 'Provider rate limit'].includes(event.title)) {
      ui.retry.textContent = event.title + (event.detail ? ' · ' + event.detail : '');
      ui.retry.hidden = false;
    }
  }
  if (event.type === 'context') renderContext(event);
  if (event.type === 'delta' && event.content) {
    ui.transcript.hidden = false;
    const current = ui['transcript-text'].textContent;
    ui['transcript-text'].textContent = (current + event.content).slice(-10000);
  }
  if (event.type === 'draft' || event.type === 'review') {
    const ready = event.type === 'review';
    renderDraft(event.snapshot, ready);
    if (ready) ui.activity.open = false;
    if (ready && event.syntax?.status === 'unavailable') log('Syntax check unavailable', event.syntax.detail);
  }
  if (event.type === 'rehearsal-start' && snapshot?.digest === event.draftDigest) {
    rehearsing = true;
    latestReceipt = undefined;
    selected = new Set(event.hunkIds);
    for (const choice of ui.files.querySelectorAll('input')) {
      choice.checked = selected.has(choice.value);
      choice.disabled = true;
    }
    ui.receipt.hidden = false;
    ui.receipt.replaceChildren(element('div', 'Checking baseline and ' + selected.size + ' selected hunks…', 'subtle'));
  }
  if (event.type === 'rehearsal' || event.type === 'rehearsal-error') {
    rehearsing = false;
    for (const choice of ui.files.querySelectorAll('input')) choice.disabled = !reviewReady;
    if (event.type === 'rehearsal-error') {
      latestReceipt = undefined;
      ui.receipt.hidden = false;
      ui.receipt.replaceChildren(element('div', event.detail, 'failure'));
    } else if (snapshot?.digest === event.draftDigest && event.hunkIds.length === selected.size && event.hunkIds.every((id) => selected.has(id))) {
      latestReceipt = event;
      renderReceipt(event);
    }
  }
  if (event.type === 'applied') {
    reviewReady = false;
    ui.review.hidden = true;
    setStep('complete');
    log('Applied to editor', event.hunkCount + ' hunks · ' + event.files.join(', '));
    if (event.verification) {
      const result = event.verification;
      const marker = String(result.evidenceId ?? '').slice(0, 12);
      const baseline = result.baseline?.status ?? result.baseline;
      const candidate = result.candidate?.status ?? result.candidate;
      ui.verification.hidden = false;
      ui.verification.replaceChildren(element('strong', result.check?.label ?? result.check), element('span',
        'Baseline ' + baseline + ' · selected hunks ' + candidate, 'subtle'), element('code', marker, 'evidence-id'));
    }
  }
  if (event.type === 'finish') {
    working = false;
    rehearsing = false;
    reviewReady = false;
    ui.cancel.hidden = true;
    ui.activity.open = false;
    ui.transcript.open = false;
    ui['new-request'].hidden = false;
    ui['new-request'].open = false;
    ui['new-label'].textContent = 'New repository edit';
    if (event.applied) setStep('complete');
    else {
      ui.review.hidden = true;
      stopProgress();
    }
  }
  refreshControls();
});
send('ready');
`;

function html(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root {
  color-scheme: light dark;
  --text: var(--vscode-foreground);
  --quiet: var(--vscode-descriptionForeground);
  --stroke: var(--vscode-panel-border, #65717966);
  --surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  --inset: var(--vscode-textCodeBlock-background);
  --accent: var(--vscode-textLink-foreground, #75bfff);
  --fail: var(--vscode-errorForeground, #e78478);
  --pass: var(--vscode-testing-iconPassed, #73c99c);
  --mono: var(--vscode-editor-font-family, monospace);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0 auto; padding: clamp(12px, 3vw, 25px); max-width: 950px; color: var(--text);
  font: var(--vscode-font-size, 13px)/1.45 var(--vscode-font-family, sans-serif); overflow-wrap: anywhere; }
h1,h2,p,ul,ol,pre { margin: 0; }
h1 { font-size: 21px; font-weight: 680; letter-spacing: -.025em; }
h2 { font-size: 1.06em; font-weight: 650; }
code,pre { font-family: var(--mono); }
button,textarea { font: inherit; }
button { cursor: pointer; min-height: 27px; padding: 4px 9px; border-radius: 4px; border: 1px solid var(--stroke);
  background: transparent; color: var(--text); }
button:hover:enabled { background: var(--vscode-toolbar-hoverBackground, var(--surface)); }
button:disabled { opacity: .48; cursor: default; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; }
button.primary:hover:enabled { background: var(--vscode-button-hoverBackground); }
:focus-visible { outline: 2px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 2px; }
.masthead,.section-head,.receipt-heading,.verdict-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px 10px; }
.masthead { align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--stroke); }
.controls { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.run-state { margin: 13px 0; padding: 11px 12px; border-inline-start: 2px solid var(--accent); background: var(--surface); border-radius: 0 5px 5px 0; }
.status-line { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; }
#status { font-weight: 650; }
#status[data-tone="error"],.failure { color: var(--fail); }
#model,#retry,.subtle,.line-range,.evidence-id,.meta { color: var(--quiet); }
#model,.evidence-id,.line-range,.meta { font-size: .86em; }
#retry { margin-top: 5px; }
#request { margin-top: 8px; white-space: pre-wrap; }
#progress { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; padding: 0; margin-top: 10px; list-style: none; }
#progress li { font-size: .86em; padding-top: 4px; border-top: 2px solid var(--stroke); color: var(--quiet); }
#progress [data-state="current"] { border-color: var(--accent); color: var(--accent); font-weight: 650; }
#progress [data-state="done"] { border-color: var(--pass); color: var(--text); }
#progress [data-state="stopped"] { border-color: var(--quiet); }
section.content { margin: 15px 0; }
.section-head { margin-bottom: 7px; }
#review { border: 1px solid var(--stroke); border-radius: 6px; padding: 10px; }
#files { display: grid; gap: 5px; margin-top: 8px; }
.file { display: flex; align-items: center; justify-content: space-between; gap: 5px 10px; flex-wrap: wrap;
  min-width: 0; padding: 4px 6px; background: var(--surface); border-radius: 4px; }
.file-link { max-width: 100%; font-family: var(--mono); text-align: left; color: var(--accent); border-color: transparent; padding: 3px 5px; font-size: .9em; }
.hunks { display: flex; flex-wrap: wrap; gap: 3px 7px; min-width: 0; }
.hunk { display: inline-flex; gap: 3px; align-items: center; font: .85em var(--mono); cursor: pointer; white-space: nowrap; }
.hunk input { accent-color: var(--accent); margin: 0 2px 0 0; }
#receipt { margin-top: 9px; padding: 8px; border: 1px solid var(--stroke); border-radius: 5px; background: var(--inset); }
.receipt-heading { margin-bottom: 6px; }
.verdicts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
.verdict { border-inline-start: 2px solid var(--stroke); border-radius: 0 4px 4px 0; background: var(--surface); padding: 6px 8px; min-width: 0; }
.verdict[data-result="passed"] { border-color: var(--pass); }
.verdict[data-result="failed"] { border-color: var(--fail); }
.verdict[data-result="passed"] .result { color: var(--pass); }
.verdict[data-result="failed"] .result { color: var(--fail); }
.result { font: .83em var(--mono); }
.verdict-output { color: var(--quiet); margin-top: 4px; white-space: pre-wrap; font-size: .9em; }
#verification { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin: 10px 0; padding: 7px 8px; border-inline-start: 2px solid var(--accent); background: var(--surface); }
summary { cursor: pointer; }
details.fold { padding: 8px 0; border-top: 1px solid var(--stroke); }
details.fold > summary,.context-more > summary { color: var(--quiet); font-weight: 600; }
#context-list details { border-top: 1px solid var(--stroke); padding: 6px 3px; }
#context-list summary code { color: var(--accent); }
.line-range { margin-inline-start: 6px; }
.context-reason { display: block; padding-inline-start: 13px; margin-top: 2px; color: var(--quiet); font-size: .91em; }
#context-list pre, #transcript-text { white-space: pre-wrap; background: var(--inset); padding: 8px; margin-top: 6px; }
#composer { margin-top: 7px; }
textarea { width: 100%; min-height: 65px; resize: vertical; padding: 8px; margin-bottom: 4px; border-radius: 4px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--stroke)); }
#activity-list { padding: 0; list-style: none; }
#activity-list li { padding: 6px 3px; border-bottom: 1px solid var(--stroke); }
#activity-list .subtle { white-space: pre-wrap; }
footer { justify-content: flex-start; border-top: 1px solid var(--stroke); margin-top: 6px; padding-top: 8px; }
@media (max-width: 370px) {
  .verdicts { grid-template-columns: 1fr; }
  .masthead h1 { font-size: 18px; }
  .run-state { padding: 8px; }
}
</style></head><body>
<header class="masthead"><h1>OurLoss</h1><div class="controls">
<button id="models" type="button" title="Select configured models">Models</button>
<button id="session" type="button" disabled>TrueForge session</button>
</div></header>

<section class="run-state" aria-label="Run status">
  <div class="status-line"><div role="status" id="status">Ready</div><code id="model" hidden></code>
    <button type="button" id="cancel" hidden>Cancel run</button></div>
  <p id="retry" hidden></p>
  <p id="request" hidden></p>
  <ol id="progress" aria-label="Run progress" hidden>
    <li data-step="inspect">Inspect</li><li data-step="review">Review</li><li data-step="apply">Apply</li>
  </ol>
</section>

<details id="new-request" class="fold" open>
  <summary id="new-label">Repository edit</summary>
  <form id="composer">
    <textarea id="instruction" aria-label="Repository instruction" placeholder="Describe a repository change"></textarea>
    <div class="controls"><button id="run" class="primary" type="submit">Run agent</button></div>
  </form>
</details>

<section id="review" class="content" aria-labelledby="review-title" hidden>
  <div class="section-head"><h2 id="review-title">Review changes</h2><span id="review-label" class="meta"></span></div>
  <div class="controls">
    <button id="rehearse" type="button" disabled>Verify selected</button>
    <button id="apply" type="button" class="primary" disabled>Apply selected</button>
    <button id="revise" type="button" disabled>Request revision</button>
    <button id="reject" type="button" disabled>Reject draft</button>
  </div>
  <div id="receipt" aria-live="polite" hidden></div><div id="files"></div>
</section>
<section id="verification" aria-label="Applied verification" hidden></section>

<section id="context" class="content" aria-labelledby="context-title" hidden>
  <div class="section-head"><h2 id="context-title">Automatic context</h2><code id="context-budget" class="meta"></code></div>
  <div id="context-list"></div>
</section>

<details id="activity" class="fold" hidden><summary id="activity-label">Run activity</summary><ul id="activity-list"></ul></details>
<details id="transcript" class="fold" hidden><summary>Model response</summary><pre id="transcript-text"></pre></details>
<footer class="controls">
  <button type="button" id="save">Save reviewed files</button><button type="button" id="undo">Undo last change</button>
</footer>
<script nonce="${nonce}">${script}</script></body></html>`;
}

class Panel {
  constructor(vscode, onMessage) {
    this.vscode = vscode;
    this.onMessage = onMessage;
    this.view = null;
    this.ready = false;
    this.history = [];
  }

  show(column = this.vscode.ViewColumn.Beside) {
    if (this.view) {
      if (!this.view.visible) this.view.reveal(column, true);
      return;
    }
    const view = this.vscode.window.createWebviewPanel('ourloss.agent', 'OurLoss Agent', { viewColumn: column, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: []
    });
    this.view = view;
    view.webview.onDidReceiveMessage((event) => {
      if (event?.type === 'ready') {
        this.ready = true;
        for (const state of this.history) void view.webview.postMessage(state);
        return;
      }
      void this.onMessage(event);
    });
    view.onDidDispose(() => {
      this.view = null;
      this.ready = false;
    });
    view.webview.html = html(randomBytes(20).toString('hex'));
  }

  publish(event) {
    if (event.type === 'begin') this.history = [];
    const last = this.history.at(-1);
    if (last?.type === 'delta' && event.type === 'delta') last.content = (last.content + event.content).slice(-10000);
    else this.history.push({ ...event });
    if (this.history.length > 450) {
      const removable = this.history.findIndex(({ type }, index) => index > 0 && type !== 'context');
      if (removable !== -1) this.history.splice(removable, 1);
    }
    if (this.ready && this.view) void this.view.webview.postMessage(event);
  }

  dispose() {
    this.view?.dispose();
  }
}

module.exports = { Panel };
