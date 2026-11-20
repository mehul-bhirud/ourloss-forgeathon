'use strict';

const { createHash } = require('node:crypto');

const PREVIEW_SCHEME = 'ourloss-review';
const MAX_FILE_BYTES = 400_000;
const MAX_EDIT_BYTES = 16_000;
const MAX_EDITS = 60;
const MAX_DIFF_CELLS = 4_000_000;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function linesWithEndings(text) {
  return (text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []).filter(Boolean);
}

function lineOffsets(lines) {
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length);
  return offsets;
}

function uniqueLineIndexes(lines, start, end) {
  const indexes = new Map();
  for (let index = start; index < end; index++) {
    const line = lines[index];
    indexes.set(line, indexes.has(line) ? -1 : index);
  }
  return indexes;
}

function collectHunks(path, before, after) {
  const oldLines = linesWithEndings(before);
  const newLines = linesWithEndings(after);
  const oldOffsets = lineOffsets(oldLines);
  const newOffsets = lineOffsets(newLines);
  const hunks = [];

  let start = 0;
  while (start < oldLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (start === oldEnd && start === newEnd) return hunks;

  const addHunk = (oldStart, oldStop, newStart, newStop) => {
    const startOffset = oldOffsets[oldStart];
    const endOffset = oldOffsets[oldStop];
    const oldText = before.slice(startOffset, endOffset);
    const newText = after.slice(newOffsets[newStart], newOffsets[newStop]);
    if (oldText === newText) return;
    hunks.push({
      id: digest([path, startOffset, endOffset, oldText, newText]),
      startOffset, endOffset, oldText, newText,
      oldStart: oldStart + 1, oldEnd: Math.max(oldStart + 1, oldStop),
      newStart: newStart + 1, newEnd: Math.max(newStart + 1, newStop),
      oldCount: oldStop - oldStart, newCount: newStop - newStart,
    });
  };

  const width = newEnd - start + 1;
  const rows = oldEnd - start + 1;
  if (rows === 1 || width === 1) {
    addHunk(start, oldEnd, start, newEnd);
    return hunks;
  }
  if (rows * width > MAX_DIFF_CELLS) {
    // Use common unique lines as anchors when the full comparison would be too large.
    const oldIndexes = uniqueLineIndexes(oldLines, start, oldEnd);
    const newIndexes = uniqueLineIndexes(newLines, start, newEnd);
    let oldStart = start;
    let newStart = start;
    for (const [line, oldIndex] of oldIndexes) {
      const newIndex = newIndexes.get(line);
      if (oldIndex < oldStart || newIndex === undefined || newIndex < newStart) continue;
      addHunk(oldStart, oldIndex, newStart, newIndex);
      oldStart = oldIndex + 1;
      newStart = newIndex + 1;
    }
    addHunk(oldStart, oldEnd, newStart, newEnd);
    return hunks;
  }

  // Keep unchanged lines as anchors so separated edits can be accepted independently.
  const matches = new Uint32Array(rows * width);
  for (let row = rows - 2; row >= 0; row--) {
    for (let column = width - 2; column >= 0; column--) {
      const index = row * width + column;
      matches[index] = oldLines[start + row] === newLines[start + column]
        ? 1 + matches[index + width + 1]
        : Math.max(matches[index + width], matches[index + 1]);
    }
  }

  let oldIndex = start;
  let newIndex = start;
  let oldStart = start;
  let newStart = start;
  while (oldIndex < oldEnd && newIndex < newEnd) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      addHunk(oldStart, oldIndex, newStart, newIndex);
      oldStart = ++oldIndex;
      newStart = ++newIndex;
      continue;
    }
    const index = (oldIndex - start) * width + newIndex - start;
    if (matches[index + width] >= matches[index + 1]) oldIndex++;
    else newIndex++;
  }
  addHunk(oldStart, oldEnd, newStart, newEnd);
  return hunks;
}

function applyHunks(before, hunks) {
  let offset = 0;
  let result = '';
  for (const hunk of hunks) {
    result += before.slice(offset, hunk.startOffset) + hunk.newText;
    offset = hunk.endOffset;
  }
  return result + before.slice(offset);
}

function normalizedPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) {
    throw new Error('Provide a workspace-relative file path.');
  }
  const result = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (result.includes(':') || result.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Provide a workspace-relative file path.');
  }
  return result;
}

function sameDocument(current, original) {
  return current?.uri?.toString() === original.uri?.toString() &&
    current?.text === original.text &&
    current?.version === original.version &&
    (original.diskText === undefined || current?.diskText === original.diskText);
}

class Draft {
  #queue = Promise.resolve();
  #files = new Map();
  #revision = 0;
  #review;
  #phase = 'drafting';
  #selection;
  #selectionEnd;

  constructor({ loadDocument, selection, isActive = () => true }) {
    this.loadDocument = loadDocument;
    this.isActive = () => this.#phase !== 'cancelled' && isActive();
    if (selection) {
      if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) ||
          selection.start < 0 || selection.end <= selection.start) {
        throw new Error('Select a non-empty range before starting an inline edit.');
      }
      this.#selection = { ...selection, path: normalizedPath(selection.path) };
      this.#selectionEnd = selection.end;
    }
  }

  #serialize(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => {});
    return next;
  }

  #assertActive() {
    if (!this.isActive()) {
      throw new Error('This run ended. Start a new run to propose or apply changes.');
    }
  }

  async #open(path) {
    const cached = this.#files.get(path);
    if (cached) return cached;
    this.#assertActive();
    const source = await this.loadDocument(path);
    this.#assertActive();
    if (!source?.uri || typeof source.text !== 'string' || source.text.includes('\0')) {
      throw new Error(`Cannot stage edits in ${path}.`);
    }
    if (Buffer.byteLength(source.text) > MAX_FILE_BYTES) {
      throw new Error(`${path} exceeds the ${MAX_FILE_BYTES}-byte edit limit.`);
    }
    if (path === this.#selection?.path) {
      const { start, end, version, text } = this.#selection;
      if (end > source.text.length || (version !== undefined && source.version !== version) ||
          (text !== undefined && source.text.slice(start, end) !== text)) {
        throw new Error('The selected text changed. Select it again and start a new run.');
      }
    }
    const rawUri = source.uri.fsPath ?? String(source.uri);
    const identity = process.platform === 'win32' ? rawUri.toLowerCase() : rawUri;
    const previous = [...this.#files.values()].find((file) => file.identity === identity);
    if (previous) throw new Error(`Use the workspace path ${previous.path} for this document.`);
    const file = { path, identity, base: Object.freeze({ ...source }), text: source.text };
    this.#files.set(path, file);
    return file;
  }

  read(path) {
    return this.#serialize(async () => {
      this.#assertActive();
      const file = await this.#open(normalizedPath(path));
      return {
        ...file.base, path: file.path, text: file.text,
        selectionEnd: file.path === this.#selection?.path ? this.#selectionEnd : undefined,
      };
    });
  }

  async readSelection() {
    if (!this.#selection) throw new Error('This run has no inline selection.');
    const { path, start } = this.#selection;
    const { text, selectionEnd } = await this.read(path);
    const preceding = text.slice(0, start);
    return {
      path,
      startLine: 1 + (preceding.match(/\r\n|\n|\r/g)?.length ?? 0),
      text: text.slice(start, selectionEnd),
    };
  }

  restoreStagedText(path, expected, original) {
    return this.#serialize(async () => {
      this.#assertActive();
      if (this.#phase !== 'drafting' || this.#selection) throw new Error('This staged file cannot be restored.');
      const file = await this.#open(normalizedPath(path));
      if (file.text !== expected) throw new Error('The staged file changed during validation.');
      file.text = original;
      this.#revision++;
      this.#review = undefined;
    });
  }

  insertAtLine({ path, line, text, after }) {
    return this.#serialize(async () => {
      this.#assertActive();
      if (this.#phase !== 'drafting' || this.#selection) throw new Error('Line insertion requires a workspace draft.');
      const target = normalizedPath(path);
      if (!Number.isInteger(line) || line < 1 || typeof text !== 'string' || !text.trim() ||
          text.includes('\0') || Buffer.byteLength(text) > MAX_EDIT_BYTES || this.#revision >= MAX_EDITS) {
        throw new Error('Provide a valid one-based line and a bounded text insertion.');
      }
      const file = await this.#open(target);
      const lines = linesWithEndings(file.text);
      if (line > lines.length) throw new Error(`${target} has ${lines.length} lines. Read the current draft for a line anchor.`);
      const offsets = lineOffsets(lines);
      const offset = offsets[after ? line : line - 1];
      const eol = file.text.match(/\r\n|\n|\r/)?.[0] ?? '\n';
      let insertion = text.replace(/\r\n|\n|\r/g, eol);
      if (offset > 0 && !/[\r\n]/.test(file.text[offset - 1])) insertion = eol + insertion;
      if (offset < file.text.length && !insertion.endsWith(eol)) insertion += eol;
      const staged = file.text.slice(0, offset) + insertion + file.text.slice(offset);
      if (Buffer.byteLength(staged) > MAX_FILE_BYTES) throw new Error('The proposed file exceeds the edit limit.');
      file.text = staged;
      this.#revision++;
      this.#review = undefined;
      return { path: target, changed: true, snapshot: this.snapshot() };
    });
  }

  propose({ path, old, new: replacement }) {
    return this.#serialize(async () => {
      this.#assertActive();
      if (this.#phase !== 'drafting') throw new Error('This draft is already under review.');
      const target = normalizedPath(path ?? this.#selection?.path);
      if (this.#selection && target !== this.#selection.path) {
        throw new Error('Inline edits must stay in the selected file and range.');
      }
      if (typeof old !== 'string' || !old.length || typeof replacement !== 'string' ||
          old.includes('\0') || replacement.includes('\0')) {
        throw new Error('Provide a non-empty exact old string and a new text string.');
      }
      if (Buffer.byteLength(old) + Buffer.byteLength(replacement) > MAX_EDIT_BYTES) {
        throw new Error('That edit is too large. Use a shorter anchor and replacement.');
      }
      if (this.#revision >= MAX_EDITS) throw new Error('This draft reached the edit limit.');
      const file = await this.#open(target);
      const start = this.#selection?.start ?? 0;
      const end = this.#selection ? this.#selectionEnd : file.text.length;
      const region = file.text.slice(start, end);
      const eol = file.text.match(/\r\n|\n|\r/)?.[0] ?? '\n';
      const anchor = old.replace(/\r\n|\n|\r/g, eol);
      const next = replacement.replace(/\r\n|\n|\r/g, eol);
      const found = region.indexOf(anchor);
      if (found === -1 || region.indexOf(anchor, found + 1) !== -1) {
        const reason = found === -1 ? 'No exact match' : 'Multiple exact matches';
        throw new Error(`${reason} in ${target}. Read the draft and use a unique exact anchor.`);
      }
      const preserved = next.indexOf(anchor);
      if (preserved >= 0 && found >= preserved && region.startsWith(next, found - preserved)) {
        return { path: target, changed: false, snapshot: this.snapshot() };
      }
      const staged = file.text.slice(0, start + found) + next + file.text.slice(start + found + anchor.length);
      if (Buffer.byteLength(staged) > MAX_FILE_BYTES) throw new Error('The proposed file exceeds the edit limit.');
      file.text = staged;
      if (this.#selection) this.#selectionEnd += next.length - anchor.length;
      this.#revision++;
      this.#review = undefined;
      return { path: target, changed: true, snapshot: this.snapshot() };
    });
  }

  #snapshot() {
    if (this.#review) return this.#review;
    const changed = [...this.#files.values()].filter(file => file.base.text !== file.text);
    const files = changed.sort((a, b) => a.path.localeCompare(b.path)).map(file => {
      const hunks = collectHunks(file.path, file.base.text, file.text).map(Object.freeze);
      return Object.freeze({ path: file.path, hunks: Object.freeze(hunks) });
    });
    this.#review = Object.freeze({
      digest: digest([this.#revision, files]),
      files: Object.freeze(files),
    });
    return this.#review;
  }

  snapshot() {
    return this.#snapshot();
  }

  freeze() {
    return this.#serialize(() => {
      this.#assertActive();
      if (this.#phase !== 'drafting' && this.#phase !== 'frozen') {
        throw new Error('This draft has already been reviewed.');
      }
      const snapshot = this.#snapshot();
      if (snapshot.files.length === 0) throw new Error('No edits were staged for review.');
      this.#phase = 'frozen';
      return snapshot;
    });
  }

  reopen(digest) {
    return this.#serialize(() => {
      this.#assertActive();
      if (this.#phase !== 'frozen' || digest !== this.#snapshot().digest) {
        throw new Error('This review can no longer be revised.');
      }
      this.#phase = 'drafting';
    });
  }

  cancel() {
    if (this.#phase !== 'applied') this.#phase = 'cancelled';
  }

  preview(path, hunkIds) {
    const target = normalizedPath(path);
    const file = this.#files.get(target);
    const proposed = this.#snapshot().files.find(entry => entry.path === target);
    if (!file || !proposed) throw new Error(`No proposed changes for ${target}.`);
    const selected = hunkIds ? new Set(hunkIds) : null;
    const hunks = proposed.hunks.filter(hunk => !selected || selected.has(hunk.id));
    return { path: target, before: file.base.text, after: applyHunks(file.base.text, hunks) };
  }

  async applyDecision(decision, applyEdit) {
    return this.#serialize(async () => {
      this.#assertActive();
      if (this.#phase !== 'frozen') throw new Error('This draft is not waiting for approval.');
      const snapshot = this.#snapshot();
      if (decision?.digest !== snapshot.digest || !Array.isArray(decision.hunkIds)) {
        throw new Error('The approval does not match the reviewed draft.');
      }
      const accepted = new Set(decision.hunkIds);
      const known = new Set(snapshot.files.flatMap(file => file.hunks.map(hunk => hunk.id)));
      if (accepted.size !== decision.hunkIds.length || [...accepted].some(id => !known.has(id))) {
        throw new Error('The approval contains an invalid hunk selection.');
      }
      const plan = [];
      for (const entry of snapshot.files) {
        const { path, base } = this.#files.get(entry.path);
        const hunks = entry.hunks.filter(hunk => accepted.has(hunk.id));
        const current = await this.loadDocument(path);
        if (!sameDocument(current, base)) throw new Error(`${path} changed since review. Start a new run.`);
        if (hunks.length) plan.push({ path, base, hunks, text: applyHunks(base.text, hunks) });
      }
      this.#assertActive();
      if (plan.length) await applyEdit(plan);
      this.#phase = 'applied';
      return { files: plan.map(file => file.path), hunkCount: accepted.size };
    });
  }
}

function createReview(vscode, context) {
  const previews = new Map();
  const provider = { provideTextDocumentContent: uri => previews.get(uri.toString()) };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider));
  let latest;
  let queue = Promise.resolve();

  function serialize(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  function previewUri(path, side, content) {
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${side}/${path}`, query: digest(content) });
    previews.set(uri.toString(), content);
    if (previews.size > 128) previews.delete(previews.keys().next().value);
    return uri;
  }

  async function readPostEdit(loadDocument, file) {
    const current = await loadDocument(file.path);
    if (current?.uri?.toString() !== file.base.uri.toString() || current?.text !== file.text) {
      throw new Error(`${file.path} changed after approval. Review the file before continuing.`);
    }
    return current;
  }

  async function liveDocuments(loadDocument, files, expected) {
    const documents = await Promise.all(files.map(file => vscode.workspace.openTextDocument(file.base.uri)));
    const current = await Promise.all(files.map(file => loadDocument(file.path)));
    for (const [index, doc] of documents.entries()) {
      const file = files[index];
      const state = expected(file);
      if (!sameDocument(current[index], state) || doc.version !== state.version || doc.getText() !== state.text) {
        throw new Error(`${file.path} changed. Review the current workspace before continuing.`);
      }
    }
    return documents;
  }

  function diskMatches(current, file) {
    return file.diskText === undefined || current.diskText === file.diskText ||
      (!current.isDirty && current.diskText === file.text);
  }

  return {
    async show(draft, path, hunkIds) {
      const { path: target, before, after } = draft.preview(path, hunkIds);
      await vscode.commands.executeCommand('vscode.diff',
        previewUri(target, 'before', before), previewUri(target, 'proposed', after),
        `OurLoss · ${target}`, { viewColumn: vscode.ViewColumn?.One, preview: true, preserveFocus: true });
    },

    apply(draft, decision) {
      return serialize(() => draft.applyDecision(decision, async plan => {
        const docs = await liveDocuments(draft.loadDocument, plan, file => file.base);
        if (!draft.isActive()) throw new Error('This run ended before its changes were applied.');
        const edit = new vscode.WorkspaceEdit();
        for (const [index, file] of plan.entries()) {
          const doc = docs[index];
          for (const hunk of file.hunks) {
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(hunk.startOffset), doc.positionAt(hunk.endOffset)), hunk.newText);
          }
        }
        // Refactoring metadata opts into VS Code's save-after-refactoring setting.
        if (!await vscode.workspace.applyEdit(edit)) {
          throw new Error('VS Code could not apply the reviewed edits.');
        }
        latest = {
          loadDocument: draft.loadDocument,
          files: plan.map((file, index) => ({
            ...file, version: docs[index].version, diskText: file.base.diskText,
          })),
        };
      }));
    },

    save() {
      return serialize(async () => {
        if (!latest) return { saved: [], failed: [] };
        const { loadDocument, files } = latest;
        const saved = [];
        const failed = [];
        for (const file of files) {
          try {
            const current = await readPostEdit(loadDocument, file);
            if (current.version !== file.version || !diskMatches(current, file)) throw new Error('The file has changed.');
            const doc = await vscode.workspace.openTextDocument(file.base.uri);
            if (doc.version !== file.version || doc.getText() !== file.text || (doc.isDirty && !await doc.save())) {
              throw new Error('VS Code could not save the reviewed text.');
            }
            const afterSave = await readPostEdit(loadDocument, file);
            file.version = afterSave.version;
            file.diskText = afterSave.diskText;
            saved.push(file.path);
          } catch (error) {
            failed.push({ path: file.path, error: error.message });
          }
        }
        return { saved, failed };
      });
    },

    undo() {
      return serialize(async () => {
        if (!latest || latest.undone) return { files: [] };
        const { loadDocument, files } = latest;
        const docs = await Promise.all(files.map(file => vscode.workspace.openTextDocument(file.base.uri)));
        const current = await Promise.all(files.map(file => readPostEdit(loadDocument, file)));
        const edit = new vscode.WorkspaceEdit();
        for (const [index, file] of files.entries()) {
          const doc = docs[index];
          if (current[index].version !== file.version || !diskMatches(current[index], file) ||
              doc.version !== file.version || doc.getText() !== file.text) {
            throw new Error(`${file.path} changed after approval. Undo would overwrite a newer change.`);
          }
          const wholeFile = new vscode.Range(doc.positionAt(0), doc.positionAt(file.text.length));
          edit.replace(doc.uri, wholeFile, file.base.text);
        }
        if (!await vscode.workspace.applyEdit(edit)) {
          throw new Error('VS Code could not undo the reviewed changes.');
        }
        const undone = files.map(file => file.path);
        latest = {
          loadDocument,
          files: files.map((file, index) => ({ ...file, text: file.base.text, version: docs[index].version, diskText: current[index].diskText })),
          undone: true,
        };
        return { files: undone };
      });
    },
  };
}

module.exports = { Draft, createReview };
