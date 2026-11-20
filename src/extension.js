'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Workspace } = require('./workspace');
const { createReview } = require('./review');
const { Runner } = require('./runner');
const { Panel } = require('./panel');

let activeRunner;

function activate(context) {
  let lastSession;
  const subscribers = new Set();
  const review = createReview(vscode, context);
  const publish = (event) => {
    if (event.type === 'session') lastSession = event.url;
    panel.publish(event);
    for (const listener of subscribers) listener(event);
  };
  const runner = new Runner({ review, publish });
  activeRunner = runner;

  function settings() {
    const config = vscode.workspace.getConfiguration('ourloss');
    const models = context.workspaceState.get('ourloss.models', {});
    return {
      trueForgeUrl: config.get('trueForgeUrl'),
      model: models.model ?? config.get('model'),
      fallbackModel: models.fallbackModel ?? config.get('fallbackModel'),
      contextBytes: config.get('contextBytes'),
      python: config.get('python'),
      modelParameters: config.get('modelParameters'),
      eagerTools: config.get('eagerTools'),
      rehearsal: config.get('rehearsal'),
      scratch: context.extensionMode === vscode.ExtensionMode.Development ?
        path.join(context.extensionPath, '.local', 'rehearsals') : context.globalStorageUri.fsPath
    };
  }

  async function workspaceFor(editor) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to enable OurLoss tools.');
    const selected = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (selected) return selected;
    if (editor) throw new Error('Select a file in the open workspace.');
    if (folders.length === 1) return folders[0];
    if (!folders.length) throw new Error('Open the repository as a VS Code folder first.');
    const picked = await vscode.window.showQuickPick(folders.map((folder) => ({
      label: folder.name, description: folder.uri.fsPath, folder
    })), { placeHolder: 'Select the repository for this request' });
    return picked?.folder;
  }

  async function start(instruction, editor, override) {
    if (runner.run) throw new Error('Finish or cancel the current run first.');
    const selectionState = editor && {
      uri: editor.document.uri,
      start: editor.document.offsetAt(editor.selection.start),
      end: editor.document.offsetAt(editor.selection.end),
      version: editor.document.version,
      text: editor.document.getText(editor.selection)
    };
    if (selectionState && !selectionState.text) throw new Error('Select a range of code first.');
    const folder = await workspaceFor(editor);
    if (!folder) return;
    if (folder.uri.scheme !== 'file') throw new Error('Choose a local workspace folder.');
    const root = folder.uri.fsPath;
    const opened = (absolutePath) => vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' &&
      sameFile(document.uri.fsPath, absolutePath));
    const readBuffer = (absolutePath) => {
      const document = opened(absolutePath);
      return document?.isDirty ? document.getText() : undefined;
    };
    const workspace = await Workspace.open(root, {
      readBuffer,
      openPaths: () => vscode.workspace.textDocuments.filter((document) => document.uri.scheme === 'file').map((document) => document.uri.fsPath)
    });
    const selection = selectionState && {
      ...selectionState, path: path.relative(root, selectionState.uri.fsPath).split(path.sep).join('/')
    };
    panel.show();
    return runner.start({
      instruction, selection, workspace, root, readBuffer, settings: { ...settings(), ...override },
      loadDocument: async (relative) => {
        const absolute = await workspace.resolve(relative);
        const uri = vscode.Uri.file(absolute);
        const document = opened(absolute) ?? await vscode.workspace.openTextDocument(uri);
        const diskText = await fs.readFile(absolute, 'utf8');
        return { uri, text: document.getText(), version: document.version, diskText, isDirty: document.isDirty };
      }
    });
  }

  async function configureModels() {
    const current = settings();
    const model = await vscode.window.showInputBox({
      title: 'Primary TrueForge model', value: current.model,
      prompt: 'Use the provider/model alias configured in TrueForge.'
    });
    if (model === undefined || !model.trim()) return;
    const fallbackModel = await vscode.window.showInputBox({
      title: 'Fallback TrueForge model', value: current.fallbackModel,
      prompt: 'Optional. Leave blank to show the primary model error.'
    });
    if (fallbackModel === undefined) return;
    await context.workspaceState.update('ourloss.models', { model: model.trim(), fallbackModel: fallbackModel.trim() });
    publish({ type: 'log', title: 'Configured models', detail: [model.trim(), fallbackModel.trim()].filter(Boolean).join(' → ') });
  }

  async function save() {
    const result = await review.save();
    publish({
      type: 'status',
      text: result.failed.length ? `Saved ${result.saved.length}. Failed: ${result.failed.join(', ')}` : `Saved ${result.saved.length} reviewed file(s)`,
      error: Boolean(result.failed.length)
    });
    return result;
  }

  async function undo() {
    const result = await review.undo();
    publish({ type: 'status', text: `Undid changes in ${result.files.length} file(s). Save to persist the undo.` });
    return result;
  }

  const actions = {
    run: (event) => start(event.instruction),
    models: configureModels,
    cancel: () => runner.cancel(),
    preview: (event) => runner.show(event.path, event.hunkIds),
    decide: (event) => runner.decide(event),
    rehearse: (event) => runner.rehearse(event),
    revise: async (event) => {
      const feedback = await vscode.window.showInputBox({
        title: 'Send review feedback to TrueForge',
        prompt: 'The selected model receives this feedback.',
        value: typeof event.feedback === 'string' ? event.feedback.slice(0, 650) : ''
      });
      if (feedback?.trim()) return runner.requestRevision({ digest: event.digest, feedback });
    },
    session: () => lastSession && vscode.env.openExternal(vscode.Uri.parse(lastSession)),
    save,
    undo
  };

  async function report(callback) {
    try {
      return await callback();
    } catch (error) {
      publish({ type: 'status', text: error.message, error: true });
      void vscode.window.showWarningMessage(`OurLoss: ${error.message}`);
      return undefined;
    }
  }

  const panel = new Panel(vscode, (event) => {
    if (Object.hasOwn(actions, event.type)) return report(() => actions[event.type](event));
  });
  context.subscriptions.push(panel,
    vscode.commands.registerCommand('ourloss.open', () => panel.show()),
    vscode.commands.registerCommand('ourloss.editSelection', () => report(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) throw new Error('Select the code you want to edit.');
      const instruction = await vscode.window.showInputBox({ title: 'Edit selection with OurLoss', prompt: 'Describe the change to this selection.' });
      if (instruction?.trim()) return start(instruction, editor);
    })),
    vscode.commands.registerCommand('ourloss.save', () => report(save)),
    vscode.commands.registerCommand('ourloss.undo', () => report(undo))
  );

  return {
    start,
    onEvent(listener) { subscribers.add(listener); return { dispose: () => subscribers.delete(listener) }; },
    preview: (file, hunks) => runner.show(file, hunks),
    decide: (decision) => runner.decide(decision),
    rehearse: (decision) => runner.rehearse(decision),
    requestRevision: (decision) => runner.requestRevision(decision),
    cancel: () => runner.cancel(),
    save,
    undo
  };
}

function sameFile(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function deactivate() {
  await activeRunner?.close();
}

module.exports = { activate, deactivate };
