'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Draft, createReview } = require('../src/review');

function fixture(contents) {
  const files = new Map(Object.entries(contents).map(([path, text]) => [
    path, { path, text, diskText: text, version: 1, uri: { toString: () => path } },
  ]));
  let provider;
  const commands = [];
  const applied = [];
  const loadDocument = async path => {
    const file = files.get(path);
    if (!file) throw new Error(`Unknown file ${path}`);
    return { ...file, isDirty: file.text !== file.diskText };
  };
  const openTextDocument = async uri => {
    const file = files.get(uri.toString());
    return {
      uri,
      get version() { return file.version; },
      get isDirty() { return file.text !== file.diskText; },
      getText: () => file.text,
      positionAt: offset => offset,
      save: async () => {
        if (file.failSave) return false;
        file.diskText = file.text;
        return true;
      },
    };
  };
  const vscode = {
    Uri: { from: value => ({ toString: () => JSON.stringify(value) }) },
    Range: class {
      constructor(start, end) { Object.assign(this, { start, end }); }
    },
    WorkspaceEdit: class {
      replacements = [];
      replace(uri, range, text) { this.replacements.push({ path: uri.toString(), ...range, text }); }
    },
    commands: { executeCommand: async (...args) => commands.push(args) },
    workspace: {
      openTextDocument,
      registerTextDocumentContentProvider: (_scheme, registered) => {
        provider = registered;
        return { dispose() {} };
      },
      applyEdit: async edit => {
        applied.push(edit.replacements);
        for (const replacement of edit.replacements.toReversed().sort((a, b) => b.start - a.start)) {
          const file = files.get(replacement.path);
          file.text = file.text.slice(0, replacement.start) + replacement.text + file.text.slice(replacement.end);
          file.version++;
        }
        return true;
      },
    },
  };
  const review = createReview(vscode, { subscriptions: [] });
  return { files, loadDocument, review, applied, commands, content: uri => provider.provideTextDocumentContent(uri) };
}

test('inline proposals remain inside the original selection and preserve the file EOL', async () => {
  const original = 'before repeated\r\ninside repeated\r\nafter repeated';
  const { loadDocument, files } = fixture({ 'a.py': original, 'b.py': 'inside repeated' });
  const start = original.indexOf('inside');
  const selection = { path: 'a.py', start, end: original.indexOf('after'), version: 1 };
  const draft = new Draft({ loadDocument, selection });
  await assert.rejects(draft.propose({ path: 'b.py', old: 'repeated', new: 'changed' }), /selected file/);
  await assert.rejects(draft.propose({ old: 'before', new: 'changed' }), /No exact match/);
  await draft.propose({ old: 'inside repeated\n', new: 'inside\nextra\n' });
  await draft.propose({ old: 'extra', new: 'another extra' });
  const expected = 'before repeated\r\ninside\r\nanother extra\r\nafter repeated';
  assert.equal((await draft.read('a.py')).text, expected);
  assert.equal((await draft.read('a.py')).selectionEnd, expected.indexOf('after'));
  assert.deepEqual(await draft.readSelection(), {
    path: 'a.py', startLine: 2, text: 'inside\r\nanother extra\r\n',
  });
  assert.equal(files.get('a.py').text, original);
  assert.equal(files.get('a.py').diskText, original);
});

test('detects stale inline selection, ambiguous exact anchors, and escaping paths', async () => {
  const { loadDocument, files } = fixture({ 'a.py': 'aaa\nend' });
  const draft = new Draft({ loadDocument });
  await assert.rejects(draft.propose({ path: '../other', old: 'end', new: 'end!' }), /workspace-relative/);
  await assert.rejects(draft.propose({ path: 'a.py', old: 'aa', new: 'x' }), /Multiple exact matches/);
  await assert.rejects(draft.propose({ path: 'a.py', old: '', new: 'x' }), /non-empty/);
  const inline = new Draft({ loadDocument, selection: { path: 'a.py', start: 0, end: 3, version: 1, text: 'aaa' } });
  files.get('a.py').version++;
  await assert.rejects(inline.readSelection(), /selected text changed/);
  assert.equal(draft.snapshot().files.length, 0);
});

test('native virtual diff previews the selected subset and a single text batch applies it', async () => {
  const original = 'first\nanchor\nlast';
  const { loadDocument, files, review, applied, commands, content } = fixture({
    'a.py': original, 'b.py': 'title\nbody\n',
  });
  const draft = new Draft({ loadDocument });
  await draft.propose({ path: 'a.py', old: 'first', new: 'first changed' });
  await draft.propose({ path: 'a.py', old: 'last', new: 'last changed\n' });
  await draft.propose({ path: 'b.py', old: 'body\n', new: '' });
  const snapshot = await draft.freeze();
  const [first, last] = snapshot.files[0].hunks;
  const secondFile = snapshot.files[1].hunks[0];
  assert.deepEqual([first.oldStart, last.oldStart, secondFile.oldStart], [1, 3, 2]);
  assert.deepEqual([last.oldText, last.newText], ['last', 'last changed\n']);
  assert.throws(() => snapshot.files.push({}));
  const selected = [last.id, secondFile.id];
  await review.show(draft, 'a.py', selected);
  assert.equal(commands[0][0], 'vscode.diff');
  assert.equal(content(commands[0][1]), original);
  assert.equal(content(commands[0][2]), 'first\nanchor\nlast changed\n');
  assert.equal(files.get('a.py').text, original);
  await assert.rejects(draft.propose({ path: 'a.py', old: 'anchor', new: 'edited' }), /already under review/);
  await assert.rejects(review.apply(draft, { digest: 'wrong', hunkIds: selected }), /does not match/);
  await assert.rejects(review.apply(draft, { digest: snapshot.digest, hunkIds: [last.id, last.id] }), /invalid hunk/);
  const decision = { digest: snapshot.digest, hunkIds: selected };
  const [accepted, duplicate] = await Promise.allSettled([
    review.apply(draft, decision), review.apply(draft, decision),
  ]);
  assert.deepEqual(accepted.value, { files: ['a.py', 'b.py'], hunkCount: 2 });
  assert.equal(duplicate.status, 'rejected');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].length, 2);
  assert.equal(files.get('a.py').diskText, original);
  assert.equal(files.get('a.py').text, 'first\nanchor\nlast changed\n');
  assert.equal(files.get('b.py').text, 'title\n');
  assert.deepEqual(await review.save(), { saved: ['a.py', 'b.py'], failed: [] });
  assert.equal(files.get('a.py').diskText, files.get('a.py').text);
  assert.deepEqual(await review.undo(), { files: ['a.py', 'b.py'] });
  assert.equal(files.get('a.py').text, original);
  assert.equal(files.get('b.py').text, 'title\nbody\n');
  assert.deepEqual(await review.undo(), { files: [] });
  assert.deepEqual(await review.save(), { saved: ['a.py', 'b.py'], failed: [] });
  assert.equal(files.get('a.py').diskText, original);
});

test('stale or cancelled approval leaves every buffer and disk file untouched', async () => {
  const { loadDocument, files, review, applied } = fixture({ 'a.py': 'a', 'b.py': 'b' });
  const draft = new Draft({ loadDocument });
  await draft.propose({ path: 'a.py', old: 'a', new: 'A' });
  await draft.propose({ path: 'b.py', old: 'b', new: 'B' });
  const snapshot = await draft.freeze();
  const hunkIds = snapshot.files.flatMap(file => file.hunks.map(hunk => hunk.id));
  files.get('b.py').diskText = 'changed externally';
  await assert.rejects(review.apply(draft, { digest: snapshot.digest, hunkIds }), /b.py changed/);
  draft.cancel();
  await assert.rejects(review.apply(draft, { digest: snapshot.digest, hunkIds }), /run ended/);
  assert.deepEqual(applied, []);
  assert.equal(files.get('a.py').text, 'a');
  assert.equal(files.get('b.py').diskText, 'changed externally');
});

test('reports save failures and blocks undo when a user has changed an accepted buffer', async () => {
  const { loadDocument, files, review } = fixture({ 'a.py': 'a', 'b.py': 'b' });
  const draft = new Draft({ loadDocument });
  await draft.propose({ path: 'a.py', old: 'a', new: 'A' });
  await draft.propose({ path: 'b.py', old: 'b', new: 'B' });
  const snapshot = await draft.freeze();
  await review.apply(draft, { digest: snapshot.digest, hunkIds: snapshot.files.flatMap(file => file.hunks.map(hunk => hunk.id)) });
  files.get('b.py').failSave = true;
  const result = await review.save();
  assert.deepEqual(result.saved, ['a.py']);
  assert.deepEqual(result.failed.map(item => item.path), ['b.py']);
  assert.equal(files.get('a.py').diskText, 'A');
  assert.equal(files.get('b.py').diskText, 'b');
  assert.equal(files.get('b.py').text, 'B');
  files.get('b.py').text = 'user change';
  files.get('b.py').version++;
  await assert.rejects(review.undo(), /b.py changed/);
  assert.equal(files.get('a.py').text, 'A');
  assert.equal(files.get('b.py').text, 'user change');
});

test('cancellation during the last asynchronous validation prevents the workspace edit', async () => {
  const { loadDocument, review, applied } = fixture({ 'a.py': 'a' });
  let reads = 0;
  const draft = new Draft({
    loadDocument: async path => {
      if (++reads === 3) draft.cancel();
      return loadDocument(path);
    },
  });
  await draft.propose({ path: 'a.py', old: 'a', new: 'A' });
  const { digest, files } = await draft.freeze();
  await assert.rejects(review.apply(draft, { digest, hunkIds: [files[0].hunks[0].id] }), /run ended/);
  assert.deepEqual(applied, []);
});

test('distant changes in a large file can still be reviewed separately', async () => {
  const middle = Array.from({ length: 2600 }, (_, i) => `unique line ${i}\n`).join('');
  const source = `first\n${middle}last`;
  const { loadDocument, files, review } = fixture({ 'large.py': source });
  const draft = new Draft({ loadDocument });
  await draft.propose({ path: 'large.py', old: 'first', new: 'first edited' });
  await draft.propose({ path: 'large.py', old: 'last', new: 'last edited' });
  const { digest, files: changed } = await draft.freeze();
  assert.equal(changed[0].hunks.length, 2);
  const last = changed[0].hunks[1];
  assert.equal(last.oldStart, 2602);
  await review.apply(draft, { digest, hunkIds: [last.id] });
  assert.equal(files.get('large.py').text, `first\n${middle}last edited`);
});
