'use strict';

const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const vscode = require('vscode');
const tasks = require('../../demo/tasks.json');

const helperPath = tasks.A.file;
const pinned = tasks.commit;

function command(file, args, root, env = {}) {
  const result = spawnSync(file, args, {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true,
    timeout: 95000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${file} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(root, ...args) {
  return command('git', args, root);
}

function clean(root) {
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '', 'The Flask checkout should be clean.');
}

async function selectFunction(root) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, helperPath)));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const source = document.getText();
  const start = source.indexOf(`def ${tasks.A.symbol}()`);
  const end = source.indexOf('\n\n\n', start);
  assert.ok(start >= 0 && end > start, 'The pinned helper has a complete selectable function.');
  editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
  editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);
  return editor;
}

async function verifyNativeDiff(api, root, snapshot) {
  clean(root);
  const before = new Map();
  for (const file of snapshot.files) {
    const uri = vscode.Uri.file(path.join(root, file.path));
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.isDirty, false, `Pending review altered the editor for ${file.path}`);
    before.set(file.path, document.getText());
  }
  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  await api.preview(snapshot.files[0].path);
  const diff = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(diff?.input instanceof vscode.TabInputTextDiff, 'The reviewed file must open in a native VS Code diff tab.');
  const original = await vscode.workspace.openTextDocument(diff.input.original);
  const proposed = await vscode.workspace.openTextDocument(diff.input.modified);
  assert.equal(original.getText(), before.get(snapshot.files[0].path));
  assert.notEqual(proposed.getText(), original.getText(), 'The proposed diff must differ from its base.');
  clean(root);
  return before;
}

function verifyFlask(task, root, output) {
  const python = process.env.OURLOSS_HOST_PYTHON;
  assert.ok(python, 'A pinned Flask environment is required for terminal verification.');
  if (task === 'B') {
    const changed = git(root, 'diff', '--name-only').split('\n').filter(Boolean);
    output.changed = changed;
  }
  const carry = path.dirname(process.env.OURLOSS_HOST_RESULT);
  output.verification = command(python, [
    path.join(__dirname, '..', '..', 'demo', 'verify_flask.py'), task, '--repo', root,
  ], root, { TEMP: carry, TMP: carry, TMPDIR: carry });
}

async function verifyRehearsal(api, task, root, snapshot, hunkIds, recording, output) {
  assert.equal(typeof api.rehearse, 'function', 'The extension must expose its review rehearsal.');
  output.rehearsals ??= [];
  const { digest } = snapshot;
  async function rehearse(name, ids, expected) {
    clean(root);
    const receipt = await api.rehearse({ digest, hunkIds: ids });
    assert.ok(receipt.digest, 'Expected a review receipt digest.');
    assert.equal(receipt.draftDigest, digest, 'The receipt must identify this draft.');
    assert.deepEqual([...receipt.hunkIds].sort(), [...ids].sort());
    assert.equal(receipt.baseline.status, 'failed', receipt.baseline.output);
    for (const file of snapshot.files) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file.path)));
      assert.equal(document.isDirty, false, `Rehearsal altered live editor buffer ${file.path}`);
    }
    clean(root);
    output.rehearsals.push({ name, receipt });
    writePhase(recording, task, `rehearsal-${name}`, {
      draftDigest: digest,
      baseline: receipt.baseline.status, candidate: receipt.candidate.status,
      digest: receipt.digest, hunks: receipt.hunkIds.length,
    });
    if (expected) assert.equal(receipt.candidate.status, expected, receipt.candidate.output);
    return receipt;
  }
  if (task === 'B') {
    const withoutImplementation = snapshot.files.filter(({ path: file }) => /^(?:docs|tests)\//.test(file));
    const subset = withoutImplementation.flatMap(({ hunks }) => hunks.map(({ id }) => id));
    if (subset.length > 0 && subset.length < hunkIds.length) {
      await api.preview(withoutImplementation[0].path, subset);
      await rehearse('subset', subset, 'failed');
      await sleep(2000);
    }
  }
  await api.preview(snapshot.files[0].path, hunkIds);
  const full = await rehearse('full', hunkIds);
  await sleep(full.candidate.status === 'passed' ? 3000 : 2000);
  return full;
}

function writePhase(directory, task, name, detail = {}) {
  if (!directory) return;
  const phase = { name, task, time: Date.now(), ...detail };
  const line = JSON.stringify(phase) + '\n';
  fsSync.appendFileSync(path.join(directory, 'phases.ndjson'), line);
  fsSync.writeFileSync(path.join(directory, 'phase.json'), line);
}

async function waitForRecording(directory, output) {
  const { task, workspace } = output;
  const details = {
    workspace, resultFile: process.env.OURLOSS_HOST_RESULT, extensionHostPid: process.pid,
    windowTitlePrefix: `OurLoss Forge-a-thon Task ${task}`,
    cdpPort: Number(process.env.OURLOSS_HOST_CDP_PORT),
  };
  await fs.writeFile(path.join(directory, 'ready.json'), JSON.stringify({ task, ...details }) + '\n');
  writePhase(directory, task, 'ready', details);
  const until = Date.now() + 45000;
  const signal = path.join(directory, 'start.signal');
  while (!fsSync.existsSync(signal)) {
    if (Date.now() >= until) throw new Error('Recording did not signal the test to start in time.');
    await sleep(100);
  }
}

async function verificationTerminal(task, output, directory) {
  if (!directory) return;
  await vscode.commands.executeCommand('notifications.clearAll').catch(() => {});
  const write = new vscode.EventEmitter();
  let transcript = output.verification ?? (`git status --short\ngit status returned no changes.\nFlask ${pinned.slice(0, 8)}\n`);
  if (task === 'B') {
    const lines = transcript.split(/\r?\n/);
    const first = lines.indexOf('{');
    const last = lines.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const json = JSON.parse(lines.slice(first, last + 1).join('\n'));
      lines.splice(first, last - first + 1, JSON.stringify(json));
    }
    transcript = lines.filter((line) => !/^\.+(?:\s+\[\d+%\])?\s*$/.test(line)).join('\n');
  }
  const terminal = vscode.window.createTerminal({
    name: `Task ${task} verification`,
    pty: {
      onDidWrite: write.event,
      open() { write.fire(transcript.replace(/\r?\n/g, '\r\n') + '\r\n'); },
      close() { write.dispose(); },
    },
  });
  terminal.show(true);
  writePhase(directory, task, 'verification', { passed: true });
  await sleep(4500);
}

async function run() {
  const task = process.env.OURLOSS_HOST_TASK;
  const target = process.env.OURLOSS_HOST_RESULT;
  const primary = process.env.OURLOSS_HOST_MODEL;
  const fallback = process.env.OURLOSS_HOST_FALLBACK ?? '';
  const recording = process.env.OURLOSS_DEMO_DIR;
  const rehearsal = Boolean(recording && process.env.OURLOSS_REHEARSAL === '1' && task !== 'C');
  const reviseOnFailure = rehearsal;
  const output = { task, primary, fallback, passed: false, events: [] };
  let listener;
  let deadline;
  let api;
  try {
    const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    assert.ok(root && /^flask-host-/.test(path.basename(root)), 'Open only a disposable Flask host fixture.');
    assert.equal(git(root, 'rev-parse', 'HEAD'), pinned);
    clean(root);
    output.workspace = root;
    const extension = vscode.extensions.getExtension('ourloss.ourloss');
    assert.ok(extension, 'OurLoss must be loaded from its development path.');
    api = await extension.activate();
    const instruction = tasks[task].prompt;
    const editor = task === 'B' ? undefined : await selectFunction(root);
    const selectedText = editor?.document.getText();
    if (recording) {
      if (task !== 'B') await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('ourloss.open');
      await waitForRecording(recording, output);
    }
    let reviewWork;
    let reviewFailure;
    let before;
    let firstPreview;
    let queuedReviews = 0;
    const begin = Date.now();
    listener = api.onEvent((event) => {
      if (event.type !== 'delta' && event.type !== 'draft') {
        output.events.push({ elapsedMs: Date.now() - begin, ...event });
      }
      if (event.type === 'begin') writePhase(recording, task, 'prompt');
      if (event.type === 'session') writePhase(recording, task, 'session', { model: event.model, id: event.id, url: event.url });
      if (recording && !firstPreview && event.type === 'draft' && event.snapshot.files.length > 0) {
        const file = event.snapshot.files[0].path;
        firstPreview = vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
          .then(() => api.preview(file))
          .then(() => writePhase(recording, task, 'first-diff', { file }))
          .catch(() => {});
      }
      if (event.type !== 'review' || (!reviseOnFailure && reviewWork)) return;
      const { snapshot } = event;
      const reviewNumber = ++queuedReviews;
      reviewWork = (reviewWork ?? Promise.resolve()).then(async () => {
        if (reviewFailure) return;
        const revisionLimit = task === 'B' ? 4 : 2;
        assert.ok(reviewNumber <= revisionLimit + 1, 'The test reached its review limit.');
        await firstPreview;
        before = await verifyNativeDiff(api, root, snapshot);
        output.previewUnchanged = true;
        writePhase(recording, task, 'preview', {
          files: snapshot.files.map((file) => file.path), draftDigest: snapshot.digest, reviewNumber,
        });
        if (recording) await sleep(3000);
        const hunkIds = task === 'C' ? [] : snapshot.files.flatMap(({ hunks }) => hunks.map(({ id }) => id));
        if (rehearsal) {
          const receipt = await verifyRehearsal(api, task, root, snapshot, hunkIds, recording, output);
          const missingRoles = task === 'B' ? ['src', 'tests', 'docs']
            .filter((role) => !snapshot.files.some((file) => file.path.startsWith(role + '/'))) : [];
          if (reviseOnFailure && (receipt.candidate.status !== 'passed' || missingRoles.length)) {
            assert.ok(['passed', 'failed'].includes(receipt.candidate.status), receipt.candidate.output);
            const feedback = [
              missingRoles.length ? `The draft is missing requested changes under ${missingRoles.join(', ')}.` : '',
              receipt.candidate.status === 'failed' ? receipt.candidate.output.trim().slice(0, 550) : '',
            ].filter(Boolean).join(' ');
            assert.ok(reviewNumber <= revisionLimit, `The final revision failed: ${feedback}`);
            assert.ok(feedback, 'The failed check must supply a diagnostic for the reviewer.');
            assert.equal(typeof api.requestRevision, 'function', 'The editor must support TrueForge revision feedback.');
            await api.requestRevision({ digest: snapshot.digest, feedback });
            output.revisions ??= [];
            output.revisions.push({ draftDigest: snapshot.digest, receiptDigest: receipt.digest, feedback });
            writePhase(recording, task, 'revision-requested', {
              reviewNumber, draftDigest: snapshot.digest, receiptDigest: receipt.digest, feedback,
            });
            return;
          }
        }
        await api.decide({ digest: snapshot.digest, hunkIds });
      }).catch(async (error) => {
        reviewFailure = error;
        await api.cancel();
      });
    });
    deadline = setTimeout(() => {
      output.timedOut = true;
      void api.cancel();
    }, Number(process.env.OURLOSS_HOST_TIMEOUT_MS));
    const checksDirectory = path.join(__dirname, '..', '..', 'demo');
    await api.start(instruction, editor, {
      model: primary,
      fallbackModel: fallback,
      ...(process.env.OURLOSS_HOST_MODEL_PARAMS && { modelParameters: JSON.parse(process.env.OURLOSS_HOST_MODEL_PARAMS) }),
      ...(process.env.OURLOSS_HOST_EAGER === '1' && { eagerTools: true }),
      ...(process.env.OURLOSS_HOST_TRUEFORGE_URL && { trueForgeUrl: process.env.OURLOSS_HOST_TRUEFORGE_URL }),
      ...(rehearsal && {
        rehearsal: {
          executable: process.env.OURLOSS_HOST_PYTHON,
          args: [path.join(checksDirectory, 'rehearsal_checks.py'), task],
          evidenceFiles: ['rehearsal_checks.py', 'verify_flask.py', 'tasks.json'].map((file) => path.join(checksDirectory, file)),
          label: task === 'A' ? 'Flask debug flag contract' : 'Flask config contract',
          timeoutMs: 30000,
        },
      }),
    });
    await reviewWork;
    if (reviewFailure) throw reviewFailure;
    assert.equal(output.timedOut, undefined, 'The live task exceeded its test deadline.');
    assert.equal(output.events.find(({ type }) => type === 'begin')?.instruction, instruction);
    const sessions = output.events.filter(({ type }) => type === 'session');
    const finish = output.events.find(({ type }) => type === 'finish');
    assert.equal(sessions[0]?.model, primary);
    if (task === 'C') {
      assert.equal(finish?.applied, false, 'Task C must finish without applying a change.');
      assert.equal(editor.document.getText(), selectedText, 'Task C altered the selected document.');
      assert.equal(editor.document.isDirty, false);
      clean(root);
      if (fallback) {
        assert.equal(sessions.length, 2);
        assert.equal(sessions[1].model, fallback);
        assert.notEqual(sessions[1].id, sessions[0].id);
        assert.ok(output.events.some(({ type, title }) => type === 'log' && title?.startsWith('Model failed')));
      } else {
        assert.ok(sessions.length >= 1 && sessions.length <= 2);
        if (sessions.length === 2) {
          assert.equal(sessions[1].model, primary);
          assert.notEqual(sessions[1].id, sessions[0].id);
          assert.ok(output.events.some(({ type, title }) => type === 'log' && /retrying after backoff/i.test(title)));
        }
        assert.ok(output.events.some(({ type, error, text }) =>
          type === 'status' && error && /ECONNREFUSED|cannot connect|unreachable/i.test(text)), 'Task C must surface the model error.');
      }
      await vscode.commands.executeCommand('ourloss.open');
      output.editorResponsive = true;
      output.gitStatus = git(root, 'status', '--short');
      writePhase(recording, task, 'failure-visible', { gitStatus: output.gitStatus });
      if (recording) await sleep(1800);
      if (recording && fallback && process.env.OURLOSS_SHOW_CANCEL === '1') {
        let stopping;
        const cancelOnActivity = api.onEvent((event) => {
          if (!stopping && (event.type === 'delta' || (event.type === 'log' && event.title === 'Read selection'))) {
            stopping = sleep(300).then(() => api.cancel());
          }
        });
        try {
          await api.start(instruction, editor, { model: fallback, fallbackModel: '' });
          await stopping;
          assert.ok(stopping, 'Cancellation must interrupt a real model turn.');
          assert.ok(output.events.some(({ type, text }) => type === 'status' && /cancelled/i.test(text)));
          clean(root);
          output.verification = 'Cancelled a live TrueForge turn.\ngit status --short -> (no output)\n' +
            `Flask ${pinned.slice(0, 8)}`;
          writePhase(recording, task, 'cancelled-live-turn', { gitStatus: '' });
        } finally {
          cancelOnActivity.dispose();
        }
      }
    } else {
      assert.equal(finish?.applied, true, 'The model did not produce a complete, accepted draft.');
      clean(root);
      output.save = await api.save();
      assert.deepEqual(output.save.failed, []);
      assert.ok(output.save.saved.length >= (task === 'A' ? 1 : 3));
      if (rehearsal) {
        const applied = output.events.find(({ type }) => type === 'applied');
        const lastReceipt = output.rehearsals.at(-1).receipt;
        assert.equal(applied?.verification?.evidenceId, lastReceipt.evidenceId);
        assert.equal(applied?.verification?.candidate, 'passed');
      }
      verifyFlask(task, root, output);
      if (recording && task === 'B') {
        const url = sessions.at(-1)?.url;
        if (url) {
          await vscode.commands.executeCommand('simpleBrowser.show', url).catch(() => {});
          writePhase(recording, task, 'harness-session', { url });
          await sleep(3800);
        }
      }
      if (task === 'A') {
        if (recording) {
          await verificationTerminal(task, output, recording);
          await vscode.commands.executeCommand('workbench.action.closePanel').catch(() => {});
          await vscode.window.showTextDocument(editor.document, { viewColumn: vscode.ViewColumn.One, preview: false });
        }
        output.undo = await api.undo();
        assert.deepEqual(output.undo.files, [helperPath]);
        assert.equal(editor.document.getText(), before.get(helperPath));
        writePhase(recording, task, 'undo');
        if (recording) await sleep(2200);
        assert.deepEqual((await api.save()).failed, []);
        clean(root);
        output.cleanAfterUndo = true;
        writePhase(recording, task, 'undo-saved', { files: output.undo.files, gitStatus: '' });
        if (recording) await sleep(850);
      }
    }
    output.passed = true;
    if (task !== 'A') await verificationTerminal(task, output, recording);
  } catch (error) {
    output.error = error.stack ?? String(error);
    await api?.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
    listener?.dispose();
    await fs.writeFile(target, JSON.stringify(output, null, 2) + '\n');
    writePhase(recording, task, 'finished', { passed: output.passed, resultFile: target });
    if (recording) {
      await fs.writeFile(path.join(recording, 'finished.signal'), JSON.stringify({
        passed: output.passed, resultFile: target, time: Date.now(),
      }) + '\n');
      await sleep(650);
    }
  }
}

module.exports = { run };
