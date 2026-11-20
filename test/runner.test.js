'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { changesKey, rateLimitWait } = require('../src/runner');
const { editorTools } = require('../src/tools');
const { Draft } = require('../src/review');

test('rate-limited turns resume only when the requested allowance can recover soon', () => {
  const limited = (constraint) => ({
    status: 'error',
    message: `[Model Error] Request failed (429): ${constraint}`,
  });
  assert.equal(rateLimitWait(limited('Limit 7000, Used 6305, Requested 2672. Please try again in 16.945714285s.')), 17296);
  assert.equal(rateLimitWait(limited('Please retry in 49.593178817s.')), 49944);
  assert.equal(rateLimitWait(limited('Limit 7000, Used 0, Requested 8000. Please try again in 12s.')), null);
  assert.equal(rateLimitWait(limited('Please try again in 420s.')), null);
  assert.equal(rateLimitWait({ status: 'done', message: 'Please try again in 1s.' }), null);
});

test('revision progress follows patch bytes even if proposal bookkeeping changes', () => {
  const first = {
    digest: 'draft-1',
    files: [{ path: 'src/demo.py', hunks: [{ id: 'old-id', startOffset: 4, endOffset: 5, oldText: 'a', newText: 'b' }] }],
  };
  const restored = structuredClone(first);
  restored.digest = 'draft-3';
  restored.files[0].hunks[0].id = 'new-id';
  assert.equal(changesKey(first), changesKey(restored));
  restored.files[0].hunks[0].newText = 'c';
  assert.notEqual(changesKey(first), changesKey(restored));
});

test('batch insertions keep their original anchors and stage append without writing', async () => {
  const source = 'def original():\n    return 1\n';
  const draft = new Draft({
    loadDocument: async () => ({ uri: 'fixture.py', text: source, diskText: source, version: 1 }),
  });
  const run = { draft, signal: new AbortController().signal, mode: 'workspace' };
  const stage = editorTools(() => run, {}, () => {}).find(({ name }) => name === 'stage_edits');
  const result = await stage.handler({ edits: [
    { path: 'fixture.py', operation: 'before', old: 'def original():', new: '# Kept the original\n' },
    { path: 'fixture.py', operation: 'append', new: '\ndef added():\n    return 2\n' }
  ] }, { sessionId: 'fixture' });
  assert.ok(result.edits.every(({ changed }) => changed));
  const preview = draft.preview('fixture.py');
  assert.equal(preview.before, source);
  assert.equal(preview.after, '# Kept the original\n' + source + '\ndef added():\n    return 2\n');
  const ambiguous = await stage.handler({ edits: [
    { path: 'fixture.py', operation: 'append', line: 1, new: '# Ambiguous\n' }
  ] }, { sessionId: 'fixture' });
  assert.match(ambiguous.edits[0].error, /Append inserts at the end/);
  assert.equal(draft.preview('fixture.py').after, preview.after);
});

test('an invalid Python stage leaves any preceding valid draft intact', async (t) => {
  const { pythonSyntax } = require('../src/tools');
  const available = await pythonSyntax(process.cwd(), {}, [{ path: 'fixture.py', text: 'counter = 1\n' }]);
  if (available.status === 'unavailable') return t.skip('Python not installed');
  const source = 'counter = 1\n';
  const draft = new Draft({ loadDocument: async () => ({ uri: 'fixture.py', text: source, diskText: source, version: 1 }) });
  const run = { draft, signal: new AbortController().signal, mode: 'workspace' };
  const stage = editorTools(() => run, {}, () => {}).find(({ name }) => name === 'stage_edits');
  await stage.handler({ edits: [{ path: 'fixture.py', old: 'counter = 1', new: 'counter = 2' }] }, { sessionId: 'fixture' });
  const invalid = { edits: [{ path: 'fixture.py', old: 'counter = 2', new: 'counter = """unterminated' }] };
  const result = await stage.handler(invalid, { sessionId: 'fixture' });
  assert.equal(result.edits[0].changed, false);
  assert.match(result.edits[0].error, /restored after syntax validation failed/);
  assert.equal(draft.preview('fixture.py').after, 'counter = 2\n');
  const restored = draft.snapshot().digest;
  assert.equal((await stage.handler(invalid, { sessionId: 'fixture' })).repeated, true);
  assert.equal(draft.snapshot().digest, restored);
});

test('line insertion preserves repeated anchors and rejects lines beyond the file', async () => {
  const source = 'repeat\r\nrepeat\r\nend';
  const draft = new Draft({ loadDocument: async () => ({ uri: 'guide.md', text: source, diskText: source, version: 1 }) });
  await assert.rejects(draft.insertAtLine({ path: 'guide.md', line: 4, text: 'wrong', after: false }), /has 3 lines/);
  await draft.insertAtLine({ path: 'guide.md', line: 2, text: 'insert', after: true });
  assert.equal(draft.preview('guide.md').before, source);
  assert.equal(draft.preview('guide.md').after, 'repeat\r\nrepeat\r\ninsert\r\nend');
});

test('replaying a replacement that retains its anchor does not duplicate the insertion', async () => {
  const source = 'Original line\nNext line\n';
  const draft = new Draft({ loadDocument: async () => ({ uri: 'guide.md', text: source, diskText: source, version: 1 }) });
  const change = { path: 'guide.md', old: 'Original line\n', new: 'Original line\nAdded line\n' };
  assert.equal((await draft.propose(change)).changed, true);
  assert.equal((await draft.propose(change)).changed, false);
  assert.equal(draft.preview('guide.md').after, 'Original line\nAdded line\nNext line\n');
});

test('an explicit whole-line insertion anchor takes precedence over a stale line', async () => {
  const source = 'First\r\n  Preferred anchor  \r\nThird\r\nLast\r\n';
  const draft = new Draft({ loadDocument: async () => ({ uri: 'guide.md', text: source, diskText: source, version: 1 }) });
  const run = { draft, signal: new AbortController().signal, mode: 'workspace' };
  const stage = editorTools(() => run, {}, () => {}).find(({ name }) => name === 'stage_edits');
  const result = await stage.handler({ edits: [
    { path: 'guide.md', operation: 'after', old: '  Preferred anchor  \n', line: 4, new: 'Inserted' },
    { path: 'guide.md', operation: 'before', old: 'Preferred anchor', line: 2, new: 'Wrong' },
  ] }, { sessionId: 'fixture' });
  assert.equal(result.edits[0].changed, true);
  assert.match(result.edits[1].error, /unique whole-line anchor/);
  assert.equal(draft.preview('guide.md').after, 'First\r\n  Preferred anchor  \r\nInserted\r\nThird\r\nLast\r\n');
});
