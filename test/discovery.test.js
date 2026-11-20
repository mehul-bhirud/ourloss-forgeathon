'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Draft } = require('../src/review');
const { editorTools, pythonSyntax } = require('../src/tools');

const path = 'src/fixture.md';
const original = 'Original fixture contents.\n';

function setup() {
  const calls = { search: [], read: [], outline: [] };
  const events = [];
  const createDraft = () => new Draft({
    loadDocument: async () => ({ uri: path, text: original, diskText: original, version: 1 }),
  });
  const run = {
    mode: 'workspace', draft: createDraft(), signal: new AbortController().signal,
    workspace: {
      async search(query, options) {
        calls.search.push({ query, options });
        return { entries: [{ path, start: 1, end: 2, excerpt: 'Search: ' + query }] };
      },
      async read(path, start, end, budget, staged) {
        calls.read.push({ path, start, end, budget, staged });
        return { path, start, end, excerpt: staged ?? original };
      },
      async outline(path, budget, query, staged) {
        calls.outline.push({ path, budget, query, staged });
        return { path, symbols: [{ name: 'fixtureHeading', line: 2, signature: 'Full declaration' }] };
      },
    },
  };
  const tools = Object.fromEntries(editorTools(() => run, {}, (event) => events.push(event))
    .map(tool => [tool.name, tool.handler]));
  const call = (name, parameters) => tools[name](parameters, { sessionId: 'test-session' });
  return { calls, events, run, call, createDraft };
}

test('genuinely different lookups do not require an intervening edit', async () => {
  const { calls, events, call } = setup();
  for (let position = 0; position < 17; position++) {
    const result = await call('search_workspace', { query: 'query ' + position });
    assert.equal(result.entries[0].excerpt, 'Search: query ' + position);
  }
  const read = await call('read_excerpt', { path, start: 2, end: 400 });
  assert.equal(read.end, 66);
  await call('outline_file', { path });
  assert.equal(calls.search.length, 17);
  assert.deepEqual(calls.search[0].options, { budget: 1600, limit: 5 });
  assert.equal(calls.read[0].budget, 1700);
  assert.equal(calls.outline[0].budget, 1200);
  assert.equal(events.filter(event => event.type === 'context').length, 17);
});

test('duplicate search, read and outline calls return compact references without duplicate UI events', async () => {
  const { calls, events, call } = setup();
  const [search, repeatedSearch] = await Promise.all([
    call('search_workspace', { query: 'foo' }), call('search_workspace', { query: '  foo  ' }),
  ]);
  assert.equal(search.entries[0].excerpt, 'Search: foo');
  assert.deepEqual(repeatedSearch.matches, [{ path, start: 1, end: 2 }]);
  assert.equal(repeatedSearch.repeated, true);
  assert.equal(repeatedSearch.entries, undefined);

  const read = await call('read_excerpt', { path });
  const repeatedRead = await call('read_excerpt', { path: '.\\src\\fixture.md', start: 1, end: 40 });
  assert.equal(read.excerpt, original);
  assert.equal(repeatedRead.repeated, true);
  assert.equal(repeatedRead.excerpt, undefined);

  const outline = await call('outline_file', { path, query: 'heading' });
  const repeatedOutline = await call('outline_file', { path, query: ' heading ' });
  assert.equal(outline.symbols[0].signature, 'Full declaration');
  assert.equal(repeatedOutline.repeated, true);
  assert.deepEqual(repeatedOutline.symbols, [{ name: 'fixtureHeading', line: 2 }]);
  assert.deepEqual(Object.values(calls).map(entries => entries.length), [1, 1, 1]);
  assert.deepEqual(events.map(event => event.label ?? event.title), ['Search results', 'Read excerpt', 'Loaded file outline']);
});

test('draft edits, explicit refresh and a new attempt restore full source results', async () => {
  const { calls, call, run, createDraft } = setup();
  assert.equal((await call('read_excerpt', { path })).excerpt, original);
  assert.ok((await call('read_excerpt', { path })).repeated);
  assert.equal((await call('read_excerpt', { path, refresh: true })).excerpt, original);
  await call('stage_edits', { edits: [{ path, old: 'Original', new: 'Revised' }] });
  const after = await call('read_excerpt', { path: '.\\src\\fixture.md' });
  assert.equal(after.excerpt, 'Revised fixture contents.\n');
  assert.ok((await call('read_excerpt', { path })).repeated);
  run.draft = createDraft();
  assert.equal((await call('read_excerpt', { path })).excerpt, original);
  assert.equal(calls.read.length, 4);
});

test('failed discoveries retry and show only one copy of the same diagnostic', async () => {
  const { events, call, run } = setup();
  const actual = run.workspace.read;
  let attempts = 0;
  run.workspace.read = async (...args) => {
    if (++attempts < 3) throw new Error('File is temporarily unavailable.');
    return actual(...args);
  };
  for (let index = 0; index < 2; index++) {
    await assert.rejects(call('read_excerpt', { path }), /temporarily unavailable/);
  }
  assert.equal((await call('read_excerpt', { path })).excerpt, original);
  assert.ok((await call('read_excerpt', { path })).repeated);
  assert.equal(attempts, 3);
  assert.equal(events.filter(event => event.title === 'Read').length, 1);
});

test('old lookup references expire while recent lookups are kept', async () => {
  const { call, calls } = setup();
  for (let index = 0; index < 60; index++) await call('search_workspace', { query: 'lookup ' + index });
  assert.ok((await call('search_workspace', { query: 'lookup 59' })).repeated);
  assert.equal((await call('search_workspace', { query: 'lookup 0' })).entries[0].excerpt, 'Search: lookup 0');
  assert.equal(calls.search.length, 61);
});

test('Python indentation diagnostics show the actual indentation and surrounding source', async (t) => {
  const result = await pythonSyntax(process.cwd(), {}, [{
    path: 'fixture.py',
    text: 'def example():\r\n    for n in (1,):\r\n        if n:\r\n        return n\r\n',
  }]);
  if (result.status === 'unavailable') return t.skip('Python interpreter not installed.');
  assert.equal(result.status, 'invalid');
  assert.match(result.diagnostic, /expected an indented block/);
  assert.match(result.diagnostic, /Line 2 \[4 spaces, 0 tabs\] '    for n in \(1,\):'/);
  assert.match(result.diagnostic, /Line 3 \[8 spaces, 0 tabs\] '        if n:'/);
  assert.match(result.diagnostic, /Line 4 \[8 spaces, 0 tabs\] '        return n'/);
});
