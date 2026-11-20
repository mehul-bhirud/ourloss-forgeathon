'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Workspace } = require('../src/workspace');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function repository(t, files) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'ourloss-workspace-'));
  const relative = path.relative(temporary, root);
  assert.match(relative, /^ourloss-workspace-[A-Za-z0-9]+$/);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
  }
  git(root, '-c', 'core.autocrlf=false', 'add', '-f', '--', '.');
  return root;
}

test('automatic context includes source, tests and the evidence guide within the serialized byte budget', async (t) => {
  const root = await repository(t, {
    'src/terminal.ts': 'export function registerCommand() {\n  program.add_command(reportCommand);\n}\n',
    'test/terminal.test.ts': 'function testReport() {\n  runner.invoke(["report"]);\n}\n',
    'docs/terminal.md': '# Built-in terminal commands\nRun the report command to inspect the product.\n',
    'test/fixtures/terminal.ts': 'const unusedFixture = "built-in terminal report command";\n',
    'src/product.ts': 'export function readReport() { return "terminal"; }\n',
  });
  const workspace = await Workspace.open(root);
  const result = await workspace.context('Add a built-in CLI report command, with a test and documentation.');
  const selected = result.entries.map((entry) => entry.path);
  assert.ok(selected.includes('src/terminal.ts'));
  assert.ok(selected.includes('test/terminal.test.ts'));
  assert.ok(selected.includes('docs/terminal.md'));
  assert.ok(selected.indexOf('test/terminal.test.ts') < selected.indexOf('test/fixtures/terminal.ts') ||
    !selected.includes('test/fixtures/terminal.ts'));
  assert.equal(Buffer.byteLength(JSON.stringify(result)), result.bytes);
  assert.ok(result.bytes <= 2400);
  assert.ok(result.entries.every(({ start, end, reason }) => start >= 1 && end >= start && reason));
});

test('a registered declaration earns a spare excerpt only when its reference is unambiguous', async (t) => {
  const source = [
    'def register_dispatch():',
    '    registry.register_handler(handler=submit_report)',
    ...Array.from({ length: 20 }, () => '# Existing implementation detail'),
    '',
    '@dispatcher.command("submit")',
    'def submit_report():',
    '    return "report submitted"',
    '',
  ].join('\n');
  const root = await repository(t, {
    'src/dispatch.py': source,
    'tests/test_dispatch.py': 'def test_submit():\n    runner.invoke(["submit"])\n',
    'docs/dispatch.md': '# Dispatch commands\n\nRun the built-in CLI command to submit a report.\n',
    'src/other.py': 'def existing_command():\n    return "new dispatch command"\n',
    'docs/overview.md': '# Command reference\n\nUse the dispatch command line.\n',
  });
  const workspace = await Workspace.open(root);
  const query = 'Add a built-in CLI dispatch command for reports, with tests and documentation.';
  const results = await workspace.context(query);
  assert.ok(results.bytes <= 2400);
  const support = results.entries.filter(entry => entry.path === 'src/dispatch.py');
  assert.equal(support.length, 2);
  assert.match(support[0].excerpt, /register_handler\(handler=submit_report\)/);
  assert.match(support[1].reason, /submit_report registered at line 2/);
  assert.match(support[1].excerpt, /@dispatcher\.command\("submit"\)\ndef submit_report\(\):/);
  assert.equal((await workspace.search(query)).entries.filter(entry => entry.path === 'src/dispatch.py').length, 1);

  await fs.appendFile(path.join(root, 'src', 'dispatch.py'), '\ndef submit_report():\n    return "ambiguous alternative"\n');
  const ambiguous = await workspace.context(query);
  assert.equal(ambiguous.entries.filter(entry => entry.path === 'src/dispatch.py').length, 1);
});

test('mentions resolve quoted paths, prefer the requested symbol and report ambiguity', async (t) => {
  const root = await repository(t, {
    'src/space name.py': 'import os\n\ndef inspect_current():\n    return "ok"\n',
    'src/other.py': 'def inspect_current():\n    return "alternate"\n',
  });
  const workspace = await Workspace.open(root);
  const result = await workspace.context(
    '@file:"src/space name.py" @symbol:inspect_current @file:src/missing.py',
  );
  assert.deepEqual(result.mentions.map(({ status }) => status), ['resolved', 'ambiguous', 'missing']);
  assert.deepEqual(result.mentions[1].matches.map(({ path: name, line }) => [name, line]), [
    ['src/space name.py', 3], ['src/other.py', 1],
  ]);
  assert.ok(result.entries.find(({ path: name }) => name === 'src/space name.py').excerpt.includes('def inspect_current'));
});

test('reads staged text and shifted symbols without writing the workspace', async (t) => {
  const root = await repository(t, { 'status.py': 'def before():\n    pass\n' });
  const workspace = await Workspace.open(root);
  const staged = '# User-reviewed draft\ndef after():\n    pass\n';
  assert.equal((await workspace.read('status.py', 2, 2, 500, staged)).excerpt, 'def after():');
  assert.equal((await workspace.outline('status.py', 500, 'after', staged)).symbols[0].line, 2);
  assert.equal((await workspace.outline('status.py')).symbols[0].name, 'before');
  assert.equal(await fs.readFile(path.join(root, 'status.py'), 'utf8'), 'def before():\n    pass\n');
  await assert.rejects(workspace.read('../status.py', 1, 1, 500, staged), /within/);
});

test('reads dirty buffers and open files with byte-safe narrower excerpts and outlines', async (t) => {
  const root = await repository(t, { 'src/main.py': 'def original():\r\n    return 1\r\n' });
  const untracked = path.join(root, 'src', 'scratch.py');
  await fs.writeFile(untracked, 'def scratch():\n    return False\n');
  const main = path.join(root, 'src', 'main.py');
  const dirty = 'def changed():\r\n    return "' + '🐼é'.repeat(900) + '"\r\n';
  const workspace = await Workspace.open(root, {
    openPaths: () => [main, untracked],
    readBuffer: async (absolute) => absolute === main ? dirty : undefined,
  });
  assert.equal((await workspace.readText('src/main.py')).text, dirty);
  assert.match((await workspace.readText('src/scratch.py')).text, /def scratch/);
  const excerpt = await workspace.read('src/main.py', 2, 2, 380);
  assert.equal(excerpt.start, 2);
  assert.equal(excerpt.end, 2);
  assert.equal(excerpt.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(excerpt)) <= 380);
  assert.doesNotMatch(excerpt.excerpt, /\p{Surrogate}/u);
  const outline = await workspace.outline('src/main.py', 380, 'changed');
  assert.equal(outline.symbols[0].name, 'changed');
  await assert.rejects(workspace.read('src/main.py', 0, 1), /one-based/);
  await assert.rejects(workspace.read('src/main.py', 500, 501), /one-based/);
});

test('excludes credentials, binary data, traversal, untracked closed files and symlink targets', async (t) => {
  const root = await repository(t, {
    'ok.py': 'def useful():\n    pass\n',
    '.env': 'TODO=never disclose\n',
    'config/credentials.json': '{"private": "never disclose"}',
    'dependency/node_modules/pkg/code.js': 'function useful() {}',
    'potential.py': 'hello-this-is-tracked',
  });
  await fs.writeFile(path.join(root, 'potential.py'), Buffer.from([0, 0xff]));
  await fs.writeFile(path.join(root, 'test_closed.py'), 'def useful():\n    pass\n');
  const link = path.join(root, 'linked.py');
  const outside = path.join(root, '.git', 'config');
  let linkCreated = false;
  try {
    await fs.symlink(outside, link);
    linkCreated = true;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  const workspace = await Workspace.open(root, { openPaths: () => linkCreated ? [link] : [] });
  await assert.rejects(workspace.readText('../ok.py'), /within/);
  await assert.rejects(workspace.readText(path.join(root, 'ok.py')), /within/);
  await assert.rejects(workspace.readText('.env'), /excluded/);
  await assert.rejects(workspace.readText('config/credentials.json'), /excluded/);
  await assert.rejects(workspace.readText('potential.py'), /binary/);
  await assert.rejects(workspace.readText('test_closed.py'), /tracked or open/);
  if (linkCreated) await assert.rejects(workspace.readText('linked.py'), /symbolic links/);
  assert.deepEqual((await workspace.search('useful')).entries.map(({ path: name }) => name), ['ok.py']);
});

test('oversize indexed files are reported and an explicit bounded read can still open them', async (t) => {
  const root = await repository(t, { 'large.py': 'def large():\n    return "' + 'x'.repeat(180000) + '"\n' });
  const workspace = await Workspace.open(root);
  const result = await workspace.context('@file:large.py');
  assert.equal(result.mentions[0].status, 'unavailable');
  assert.equal(result.skipped, 1);
  assert.equal((await workspace.read('large.py', 1, 1)).excerpt, 'def large():');
});

test('Flask 3.1.3 retrieves all reference files on the fixed task and the independent holdout', {
  skip: !process.env.OURLOSS_FLASK_CHECKOUT,
}, async () => {
  const root = process.env.OURLOSS_FLASK_CHECKOUT;
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  const baseline = git(root, 'status', '--porcelain', '--untracked-files=all');
  const workspace = await Workspace.open(root);
  const cases = [
    [
      'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.',
      ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst'],
    ],
    [
      'Trace how a custom session interface can inspect the matched endpoint while opening a session, and find the lifecycle explanation and regression test.',
      ['src/flask/sessions.py', 'tests/test_session_interface.py', 'docs/lifecycle.rst'],
    ],
  ];
  for (const [index, [query, targets]] of cases.entries()) {
    const result = await workspace.context(query);
    assert.ok(result.bytes <= 2400);
    assert.ok(result.entries.length <= 5);
    for (const target of targets) {
      assert.ok(result.entries.some(({ path: name }) => name === target), 'Missing ' + target);
    }
    const linked = result.entries.filter(entry => entry.reason.startsWith('Definition of '));
    if (index === 0) {
      assert.match(result.entries[0].excerpt, /self\.add_command\(routes_command\)/);
      assert.match(result.entries.find(entry => entry.path === 'docs/cli.rst').excerpt, /Run the Development Server\n-+/);
      assert.match(result.entries.find(entry => entry.reason.startsWith('Constructs ')).excerpt, /cli = FlaskGroup\(/);
      assert.deepEqual(linked.map(entry => entry.path), ['src/flask/cli.py']);
      assert.match(linked[0].excerpt, /@click\.command\("routes"/);
      assert.match(linked[0].excerpt, /def routes_command\(/);
    } else {
      assert.deepEqual(linked, []);
    }
  }
  const offTask = await workspace.context(
    'Locate how the test client handles redirects and cookies, including implementation, tests, and user documentation.',
  );
  assert.ok(offTask.bytes <= 2400);
  assert.ok(offTask.entries.some(entry => entry.path === 'tests/test_testing.py'));
  assert.ok(offTask.entries.some(entry => entry.path === 'docs/testing.rst'));
  assert.equal(new Set(offTask.entries.map(entry => entry.path)).size, offTask.entries.length);
  const outline = await workspace.outline('src/flask/cli.py', 1200, 'routes command');
  assert.ok(outline.symbols.some(({ name }) => name === 'routes_command'));
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), baseline);
});
