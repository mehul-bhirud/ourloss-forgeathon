'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { rehearse, rehearsalDigest } = require('../src/rehearse');

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(temp, 'ourloss-rehearsal-test-'));
  assert.match(path.relative(temp, folder), /^ourloss-rehearsal-test-[A-Za-z0-9]+$/);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const root = path.join(folder, 'source');
  const scratch = path.join(folder, 'scratch');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'candidate.txt'), 'saved\n');
  await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([0, 42, 255]));
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'core.autocrlf=false', 'add', '--', '.');
  return { root, scratch, git };
}

test('compares the same tracked workspace content with the exact selected subset', async (t) => {
  const { root, scratch, git } = await fixture(t);
  const workingTree = git('status', '--porcelain');
  const envName = 'OURLOSS_REHEARSAL_TEST_CREDENTIAL';
  const prior = process.env[envName];
  process.env[envName] = 'secret-only-in-parent-process';
  t.after(() => {
    if (prior === undefined) delete process.env[envName];
    else process.env[envName] = prior;
  });
  const check = {
    label: 'Check selected content',
    executable: process.execPath,
    args: ['-e', `
      const fs = require('node:fs');
      const path = require('node:path');
      const text = fs.readFileSync('src/candidate.txt', 'utf8').trim();
      console.log(text);
      if (process.env.${envName}) throw new Error('Inherited credential');
      if (fs.readFileSync('data.bin')[2] !== 255) throw new Error('Missing binary');
      if (process.env.PYTHONPATH.split(path.delimiter)[0] !== path.join(process.cwd(), 'src')) throw new Error('Wrong import root');
      if (fs.existsSync('.git')) throw new Error('Unexpected Git metadata');
      process.exitCode = text === 'selected' ? 0 : 3;
    `],
  };
  const source = {
    root, scratch, check,
    readBuffer: (absolute) => absolute === path.join(root, 'src', 'candidate.txt') ? 'dirty editor\n' : undefined,
  };
  const selection = [{ path: 'src/candidate.txt', before: 'dirty editor\n', after: 'selected\n' }];
  const result = await rehearse({ ...source, files: selection });
  assert.equal(result.baseline.status, 'failed');
  assert.equal(result.baseline.code, 3);
  assert.equal(result.baseline.output, 'dirty editor');
  assert.equal(result.candidate.status, 'passed');
  assert.equal(result.candidate.output, 'selected');
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(await rehearsalDigest({ ...source, files: selection }), result.digest);
  const different = await rehearse({
    ...source, files: [{ ...selection[0], after: 'different\n' }],
  });
  assert.notEqual(result.digest, different.digest);
  await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([0, 42, 254]));
  assert.notEqual(await rehearsalDigest({ ...source, files: selection }), result.digest);
  await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([0, 42, 255]));
  assert.equal(await fs.readFile(path.join(root, 'src', 'candidate.txt'), 'utf8'), 'saved\n');
  assert.equal(git('status', '--porcelain'), workingTree);
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('rejects changed bases, traversal, and untracked paths before launching the process', async (t) => {
  const { root, scratch } = await fixture(t);
  const check = { executable: process.execPath, args: ['-e', 'throw Error("must not run")'] };
  await assert.rejects(rehearse({
    root, scratch, check, files: [{ path: 'src/candidate.txt', before: 'stale', after: 'draft' }],
  }), /base changed/);
  await assert.rejects(rehearse({
    root, scratch, check, files: [{ path: '../outside.txt', before: '', after: 'draft' }],
  }), /workspace-relative/);
  await assert.rejects(rehearse({
    root, scratch, check, files: [{ path: 'untracked.txt', before: '', after: 'draft' }],
  }), /tracked file/);
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('binds external verifier content to the receipt without including its absolute path', async (t) => {
  const { root, scratch } = await fixture(t);
  const probe = path.join(path.dirname(root), 'independent-probe.cjs');
  await fs.writeFile(probe, 'console.log(__filename);');
  const options = {
    root, scratch, files: [{ path: 'src/candidate.txt', before: 'saved\n', after: 'draft' }],
    check: { executable: process.execPath, args: [probe], evidenceFiles: [probe] },
  };
  const original = await rehearse(options);
  assert.equal(original.candidate.status, 'passed');
  assert.equal(original.candidate.output, '[independent-probe.cjs]');
  assert.equal(original.check.evidenceFiles, 1);
  assert.ok(!JSON.stringify(original).includes(probe));
  assert.equal(await rehearsalDigest(options), original.digest);
  await fs.writeFile(probe, 'process.exitCode = 3;');
  const changed = await rehearse(options);
  assert.equal(changed.candidate.status, 'failed');
  assert.notEqual(changed.digest, original.digest);
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('rejects an external verifier that changes during the rehearsal', async (t) => {
  const { root, scratch } = await fixture(t);
  const probe = path.join(path.dirname(root), 'mutable-probe.cjs');
  const sentinel = path.join(path.dirname(root), 'probe-ran');
  await fs.writeFile(probe, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'running');
    setTimeout(() => {}, 500);`);
  const options = {
    root, scratch, files: [{ path: 'src/candidate.txt', before: 'saved\n', after: 'draft' }],
    check: { executable: process.execPath, args: [probe], evidenceFiles: [probe] },
  };
  const operation = rehearse(options);
  const expected = assert.rejects(operation, /Check evidence changed during rehearsal/);
  const deadline = Date.now() + 3000;
  while (!await fs.access(sentinel).then(() => true, () => false)) {
    assert.ok(Date.now() < deadline, 'Baseline check did not start');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  await fs.appendFile(probe, '\nconsole.log("Changed")');
  await expected;
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('rejects case-folded tracked aliases on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, scratch, git } = await fixture(t);
  const object = git('hash-object', '-w', 'src/candidate.txt').trim();
  git('update-index', '--add', '--cacheinfo', '100644,' + object + ',src/Candidate.txt');
  await assert.rejects(rehearse({
    root, scratch, files: [{ path: 'src/candidate.txt', before: 'saved\n', after: 'draft' }],
    check: { executable: process.execPath, args: ['-e', 'throw Error("must not run")'] },
  }), /case-colliding/);
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('reports missing executables, bounded output, and timeout distinctly', async (t) => {
  const { root, scratch } = await fixture(t);
  const files = [{ path: 'src/candidate.txt', before: 'saved\n', after: 'draft' }];
  const unavailable = await rehearse({ root, scratch, files, check: {
    executable: path.join(root, 'does-not-exist.ourloss'), args: [],
  } });
  assert.equal(unavailable.baseline.status, 'unavailable');
  assert.equal(unavailable.candidate.status, 'unavailable');
  const timeout = await rehearse({ root, scratch, files, check: {
    executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 75,
  } });
  assert.equal(timeout.candidate.status, 'timeout');
  const output = await rehearse({ root, scratch, files, check: {
    executable: process.execPath, args: ['-e', 'console.log("a".repeat(12500))'],
  } });
  assert.equal(output.candidate.status, 'passed');
  assert.equal(output.candidate.truncated, true);
  assert.equal(Buffer.byteLength(output.candidate.output), 2800);
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('cancelling an active rehearsal clears the isolated snapshots', async (t) => {
  const { root, scratch, git } = await fixture(t);
  const controller = new AbortController();
  const before = git('status', '--porcelain');
  const timer = setTimeout(() => controller.abort(), 350);
  t.after(() => clearTimeout(timer));
  await assert.rejects(rehearse({
    root, scratch, signal: controller.signal,
    files: [{ path: 'src/candidate.txt', before: 'saved\n', after: 'draft' }],
    check: { executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'] },
  }), { name: 'AbortError' });
  assert.equal(git('status', '--porcelain'), before);
  assert.deepEqual(await fs.readdir(scratch), []);
});
