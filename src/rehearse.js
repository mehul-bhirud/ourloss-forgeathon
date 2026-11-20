'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_OUTPUT = 2800;
const MAX_EVIDENCE_FILE = 2 * 1024 * 1024;
const INHERITED_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'TZ',
]);

function fileKey(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

function within(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative !== '..' && Boolean(relative) && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function relativeFile(filename) {
  if (typeof filename !== 'string' || !filename || /[\\:\u0000-\u001f]/.test(filename) ||
      filename.split('/').some(part => ['', '.', '..', '.git'].includes(part.toLowerCase()))) {
    throw new Error('Rehearsal requires an existing workspace-relative path.');
  }
  return filename;
}

function normalizeCheck(check) {
  if (!check || typeof check.executable !== 'string' || !check.executable.trim() ||
      /[\0\r\n]/.test(check.executable) || !Array.isArray(check.args) || check.args.length > 32 ||
      check.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
    throw new Error('Configure a check with an executable and an argument array.');
  }
  const declared = check.evidenceFiles ?? [];
  if (!Array.isArray(declared) || declared.length > 8 ||
      declared.some(file => typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file))) {
    throw new Error('Declare up to eight absolute check evidence files.');
  }
  const evidenceFiles = [...new Map(declared.map(file => {
    const absolute = path.resolve(file);
    return [fileKey(absolute), absolute];
  })).values()];
  return {
    executable: check.executable,
    args: [...check.args],
    label: typeof check.label === 'string' ? check.label.slice(0, 160) : path.basename(check.executable).slice(0, 120),
    timeoutMs: Number.isSafeInteger(check.timeoutMs) ? Math.max(50, Math.min(check.timeoutMs, 120000)) : 30000,
    evidenceFiles,
  };
}

async function captureEvidence(files, signal) {
  const result = [];
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_EVIDENCE_FILE) throw new Error('Invalid evidence file.');
      const contents = await readDisk(file, stat.size);
      const current = await fs.lstat(file);
      if (stat.ino !== current.ino || stat.ctimeMs !== current.ctimeMs || stat.mtimeMs !== current.mtimeMs) {
        throw new Error('Unstable evidence file.');
      }
      result.push({ file, hash: createHash('sha256').update(contents).digest('hex'),
        version: [stat.dev, stat.ino, stat.ctimeMs, stat.mtimeMs] });
    } catch {
      throw new Error(`Check evidence file ${index + 1} must be a stable regular file of at most 2 MiB.`);
    }
  }
  return result;
}

async function verifyEvidence(check, captured, signal) {
  const current = await captureEvidence(check.evidenceFiles, signal);
  if (JSON.stringify(current) !== JSON.stringify(captured)) {
    throw new Error('Check evidence changed during rehearsal. Run the check again.');
  }
}

async function collect(root, readBuffer, signal) {
  const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '--cached', '-z'], {
    signal, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  const names = [...new Set(stdout.split('\0').filter(Boolean))];
  if (names.length > MAX_FILES) throw new Error('Rehearsal supports up to 5,000 tracked files.');
  if (new Set(names.map(fileKey)).size !== names.length) {
    throw new Error('Rehearsal cannot copy case-colliding tracked paths.');
  }
  const files = new Map();
  let total = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    const relative = relativeFile(name);
    const filename = path.join(root, relative);
    let resolved;
    let stat;
    try {
      stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) throw new Error('Rehearsal cannot copy a symbolic link: ' + relative);
      resolved = await fs.realpath(filename);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!within(root, resolved) || fileKey(resolved) !== fileKey(filename)) {
      throw new Error('Rehearsal cannot copy a symbolic link: ' + relative);
    }
    if (!stat.isFile()) throw new Error('Rehearsal requires regular tracked files: ' + relative);
    const open = await readBuffer(resolved);
    const bytes = typeof open === 'string' ? Buffer.byteLength(open, 'utf8') : stat.size;
    if (total + bytes > MAX_BYTES) throw new Error('Rehearsal supports up to 32 MiB of tracked content.');
    const content = typeof open === 'string' ? Buffer.from(open, 'utf8') : await readDisk(resolved, stat.size);
    total += content.length;
    files.set(fileKey(relative), { relative, content, mode: stat.mode & 0o777 });
  }
  return files;
}

async function readDisk(filename, expectedSize) {
  const file = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.allocUnsafe(expectedSize + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== expectedSize) throw new Error('A tracked file changed during rehearsal collection: ' + path.basename(filename));
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

function select(files, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('Select at least one change to rehearse.');
  const selected = new Map();
  for (const change of changes) {
    const relative = relativeFile(change.path);
    const key = fileKey(relative);
    const entry = files.get(key);
    if (!entry) throw new Error('Rehearsal requires a tracked file: ' + relative);
    if (selected.has(key)) throw new Error('Rehearsal received a duplicate path: ' + relative);
    if (typeof change.before !== 'string' || typeof change.after !== 'string') {
      throw new Error('Rehearsal requires before and after text for ' + relative);
    }
    if (Buffer.byteLength(change.after, 'utf8') > MAX_BYTES) {
      throw new Error('Rehearsal supports up to 32 MiB of tracked content.');
    }
    if (!entry.content.equals(Buffer.from(change.before, 'utf8'))) {
      throw new Error('The selected base changed before rehearsal: ' + relative);
    }
    selected.set(key, change.after);
  }
  const size = [...files].reduce((total, [key, file]) => total +
    (selected.has(key) ? Buffer.byteLength(selected.get(key), 'utf8') : file.content.length), 0);
  if (size > MAX_BYTES) throw new Error('Rehearsal supports up to 32 MiB of tracked content.');
  return new Map([...selected].map(([key, text]) => [key, Buffer.from(text, 'utf8')]));
}

function hashPlan(files, edited, check, evidence) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([check.executable, check.args, check.timeoutMs,
    evidence.map(({ file, hash }) => [file, hash])]));
  for (const [key, file] of files) {
    const selected = edited.get(key);
    hash.update(JSON.stringify([file.relative, file.mode, file.content.length, selected?.length ?? null]));
    hash.update(file.content);
    if (selected) hash.update(selected);
  }
  return hash.digest('hex');
}

async function writeSnapshot(root, files, changes, signal) {
  await fs.mkdir(root);
  const directories = new Set([...files.values()].map(file => path.dirname(path.join(root, file.relative))));
  for (const directory of directories) {
    signal?.throwIfAborted();
    if (directory !== root) await fs.mkdir(directory, { recursive: true });
  }
  const entries = [...files.entries()];
  for (let index = 0; index < entries.length; index += 24) {
    signal?.throwIfAborted();
    await Promise.all(entries.slice(index, index + 24).map(([key, file]) =>
      fs.writeFile(path.join(root, file.relative), changes.get(key) ?? file.content, { mode: file.mode })));
  }
}

function processEnv(cwd, temp) {
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => INHERITED_ENV.has(name.toUpperCase())));
  return {
    ...inherited, TEMP: temp, TMP: temp, TMPDIR: temp,
    PYTHONPATH: [path.join(cwd, 'src'), cwd].join(path.delimiter), PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', FLASK_SKIP_DOTENV: '1', NO_COLOR: '1',
  };
}

function redactCheckPaths(text, check, cwd, temp) {
  const paths = [cwd, temp, check.executable, ...check.args, ...check.evidenceFiles].filter(path.isAbsolute);
  for (const file of paths) {
    const replacement = file === cwd || file === temp ? '[snapshot]' : '[' + path.basename(file) + ']';
    for (const spelling of new Set([file, file.replaceAll('/', '\\'), file.replaceAll('\\', '/')])) {
      text = text.replaceAll(spelling, replacement);
    }
  }
  return text;
}

function runCheck(check, cwd, temp, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(check.executable, check.args, {
      cwd, env: processEnv(cwd, temp), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const output = [];
    let captured = 0;
    let truncated = false;
    let timeout = false;
    let launchError;
    const stop = () => child.kill();
    const timer = setTimeout(() => {
      timeout = true;
      stop();
    }, check.timeoutMs);
    const addOutput = (chunk) => {
      const kept = chunk.subarray(0, Math.max(0, MAX_OUTPUT - captured));
      if (kept.length) output.push(kept);
      captured += kept.length;
      truncated ||= kept.length < chunk.length;
    };
    child.stdout.on('data', addOutput);
    child.stderr.on('data', addOutput);
    child.on('error', (error) => { launchError = error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(signal.reason);
      const status = timeout ? 'timeout' : launchError ? 'unavailable' : code === 0 ? 'passed' : 'failed';
      return resolve({
        status, code, durationMs: Math.round(performance.now() - started),
        output: redactCheckPaths(launchError ? launchError.message : Buffer.concat(output).toString('utf8').trim(), check, cwd, temp),
        truncated,
      });
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

async function prepare({ root, files, check, signal, readBuffer = async () => undefined }) {
  signal?.throwIfAborted();
  const command = normalizeCheck(check);
  const sourceRoot = await fs.realpath(root);
  const evidence = await captureEvidence(command.evidenceFiles, signal);
  const source = await collect(sourceRoot, readBuffer, signal);
  const selection = select(source, files);
  return { command, source, selection, evidence, digest: hashPlan(source, selection, command, evidence) };
}

async function rehearsalDigest(options) {
  return (await prepare(options)).digest;
}

async function rehearse({ scratch, ...options }) {
  const { signal } = options;
  signal?.throwIfAborted();
  if (typeof scratch !== 'string' || !path.isAbsolute(scratch)) throw new Error('A local rehearsal directory is required.');
  await fs.mkdir(scratch, { recursive: true });
  const scratchRoot = await fs.realpath(scratch);
  const { command, source, selection, digest, evidence } = await prepare(options);
  const operation = await fs.mkdtemp(path.join(scratchRoot, 'run-'));
  try {
    const baselinePath = path.join(operation, 'base');
    const candidatePath = path.join(operation, 'candidate');
    const baselineTemp = path.join(operation, 'base-tmp');
    const candidateTemp = path.join(operation, 'candidate-tmp');
    await fs.mkdir(baselineTemp);
    await fs.mkdir(candidateTemp);
    await writeSnapshot(baselinePath, source, new Map(), signal);
    await verifyEvidence(command, evidence, signal);
    const baseline = await runCheck(command, baselinePath, baselineTemp, signal);
    await writeSnapshot(candidatePath, source, selection, signal);
    await verifyEvidence(command, evidence, signal);
    const candidate = await runCheck(command, candidatePath, candidateTemp, signal);
    await verifyEvidence(command, evidence, signal);
    return {
      baseline, candidate, digest, check: { label: command.label, timeoutMs: command.timeoutMs, evidenceFiles: evidence.length },
      description: `${source.size} tracked files. Selected changes in ${selection.size} file${selection.size === 1 ? '' : 's'}.`,
    };
  } finally {
    const resolved = await fs.realpath(operation).catch(() => undefined);
    if (resolved && within(scratchRoot, resolved) && fileKey(path.dirname(resolved)) === fileKey(scratchRoot) &&
        /^run-[A-Za-z0-9]+$/.test(path.basename(resolved))) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}

module.exports = { rehearse, rehearsalDigest };
