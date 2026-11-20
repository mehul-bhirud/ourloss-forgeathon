'use strict';

const { spawn } = require('node:child_process');

const string = { type: 'string' };
const integer = { type: 'integer', minimum: 1 };
const refreshFlag = { type: 'boolean' };
const DISCOVERY_HISTORY_LIMIT = 48;
const PYTHON_SYNTAX_CHECK = [
  'import ast, sys',
  'source = sys.stdin.buffer.read().decode("utf-8")',
  'try:',
  '    ast.parse(source, filename=sys.argv[1])',
  'except SyntaxError as exc:',
  '    print(f"{exc.lineno}:{exc.offset} {exc.msg}")',
  '    if isinstance(exc, IndentationError) and exc.lineno:',
  '        lines = source.replace("\\r\\n", "\\n").replace("\\r", "\\n").split("\\n")',
  '        for number in range(max(1, exc.lineno - 2), min(len(lines), exc.lineno + 2) + 1):',
  '            text = lines[number - 1]',
  '            indent = text[:len(text) - len(text.lstrip(" \\t"))]',
  '            spaces, tabs = indent.count(" "), indent.count("\\t")',
  '            print(f"Line {number} [{spaces} spaces, {tabs} tabs] {text[:240]!r}")',
  '    elif exc.text:',
  '        print(repr(exc.text.rstrip("\\r\\n")[:240]))',
  '    sys.exit(1)',
].join('\n');

function tool(name, description, properties, required, handler, options = {}) {
  return {
    name, description, handler,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: !options.approval },
    ...options
  };
}

function limitedProcess(executable, args, { cwd, input, signal, timeout = 3500 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, signal, stdio: 'pipe' });
    const timer = setTimeout(() => child.kill(), timeout);
    let bytes = 0;
    let output = '';
    const collect = (data) => {
      if (bytes >= 3500) return;
      const part = data.subarray(0, 3500 - bytes);
      bytes += part.length;
      output += part.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function pythonSyntax(root, settings, files, signal) {
  const pythonFiles = files.filter(({ path: file }) => file.endsWith('.py'));
  if (!pythonFiles.length) return { status: 'none' };
  const isWindows = process.platform === 'win32';
  const executable = settings.python || (isWindows ? 'py' : 'python3');
  const prefix = executable === 'py' ? ['-3'] : [];
  for (const file of pythonFiles) {
    try {
      const result = await limitedProcess(executable, [
        ...prefix, '-I', '-c', PYTHON_SYNTAX_CHECK, file.path,
      ], { input: file.text, signal });
      if (result.code !== 0) return { status: 'invalid', path: file.path, diagnostic: result.output.trim() || 'Python did not finish.' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: 'unavailable', detail: error.message };
    }
  }
  return { status: 'valid', files: pythonFiles.length };
}

function editorTools(getRun, review, publish) {
  const discovery = new WeakMap();
  const invalidBatches = new WeakMap();

  function sourceKey(path) {
    const relative = path.replaceAll('\\', '/').replace(/^\.\//, '');
    return process.platform === 'win32' ? relative.toLowerCase() : relative;
  }

  async function stagedText(run, path) {
    const staged = run.draft.snapshot().files.find((file) => sourceKey(file.path) === sourceKey(path));
    return staged ? (await run.draft.read(staged.path)).text : undefined;
  }

  function handle(name, execute, reportError = true) {
    return async (args, { sessionId }) => {
      const run = getRun(sessionId);
      if (!run || run.signal.aborted) throw new Error('This editing session has ended.');
      try {
        return await execute(run, args);
      } catch (error) {
        if (reportError) publish({ type: 'log', title: name, detail: error.message });
        throw error;
      }
    };
  }

  function remember(history, key, value) {
    history.delete(key);
    history.set(key, value);
    if (history.size > DISCOVERY_HISTORY_LIMIT) history.delete(history.keys().next().value);
  }

  async function discover(run, title, parameters, refresh, lookup, summarize) {
    const { digest } = run.draft.snapshot();
    let history = discovery.get(run.draft);
    if (!history || history.digest !== digest) {
      history = { digest, lookups: new Map(), errors: new Map() };
      discovery.set(run.draft, history);
    }
    const key = JSON.stringify([title, parameters]);
    const previous = history.lookups.get(key);
    if (previous && !refresh) {
      remember(history.lookups, key, previous);
      return {
        repeated: true,
        ...summarize(await previous),
        message: 'Already retrieved for this draft. Reuse the earlier result, change the lookup, or set refresh to true.',
      };
    }
    const pending = Promise.resolve().then(lookup);
    remember(history.lookups, key, pending);
    try {
      return await pending;
    } catch (error) {
      if (history.lookups.get(key) === pending) history.lookups.delete(key);
      const errorKey = JSON.stringify([key, error.message]);
      if (!history.errors.has(errorKey)) publish({ type: 'log', title, detail: error.message });
      remember(history.errors, errorKey, true);
      throw error;
    }
  }

  async function stage(run, args, show = true, draft = run.draft) {
    const path = args.path || run.selection?.path;
    let old = args.old;
    let replacement = args.new;
    let result;
    if (args.operation === 'before' || args.operation === 'after') {
      let line = args.line;
      const after = args.operation === 'after';
      if (typeof old === 'string' && old.trim()) {
        const { text } = await draft.read(path);
        const eol = text.match(/\r\n|\n|\r/)?.[0] ?? '\n';
        const anchor = old.replace(/(?:\r\n|\n|\r)+$/, '').replace(/\r\n|\n|\r/g, eol);
        const haystack = eol + text + eol;
        const match = eol + anchor + eol;
        const index = haystack.indexOf(match);
        if (index < 0 || haystack.indexOf(match, index + eol.length) >= 0) {
          throw new Error('Use a unique whole-line anchor with its indentation, or omit old and provide a current staged line number.');
        }
        line = text.slice(0, index).split(eol).length;
        if (after) line += anchor.split(eol).length - 1;
      }
      result = await draft.insertAtLine({ path, line, text: replacement, after });
    } else if (args.operation === 'append' && !run.selection) {
      if (args.line !== undefined || old) {
        throw new Error('Append inserts at the end of the file. Use before or after for a reference line.');
      }
      const { text } = await draft.read(path);
      if (typeof replacement !== 'string' || !replacement) throw new Error('Provide text to append.');
      old = text.slice(-400);
      replacement = old + replacement;
    }
    result ??= await draft.propose({ path, old, new: replacement });
    if (result.changed && show) {
      publish({ type: 'draft', snapshot: result.snapshot });
      publish({ type: 'log', title: 'Staged edit', detail: result.path });
    }
    return { path: result.path, changed: result.changed };
  }
  async function stageBatch(run, args) {
    if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 8) throw new Error('Provide one to eight edits.');
    const edits = [];
    const initial = new Map();
    const draft = run.draft;
    const body = JSON.stringify(args.edits);
    const previous = invalidBatches.get(draft);
    if (previous?.body === body && previous.digest === draft.snapshot().digest) {
      return { repeated: true, message: 'This exact batch failed its syntax check. Inspect the current code and change the edit before retrying.' };
    }
    let failedSyntax = false;
    for (const item of args.edits) {
      try {
        const before = (await draft.read(item.path)).text;
        if (!initial.has(item.path)) initial.set(item.path, before);
        edits.push(await stage(run, item, false, draft));
      } catch (error) {
        edits.push({ path: item?.path, changed: false, error: error.message });
      }
    }
    for (const [path, before] of initial) {
      if (!edits.some((entry) => entry.path === path && entry.changed)) continue;
      const candidate = await draft.read(path);
      const syntax = await pythonSyntax(run.root, run.settings ?? {}, [candidate], run.signal);
      if (syntax.status === 'invalid') {
        failedSyntax = true;
        await draft.restoreStagedText(path, candidate.text, before);
        for (const entry of edits.filter((entry) => entry.path === path && entry.changed)) {
          entry.changed = false;
          entry.error = `This file was restored after syntax validation failed. ${syntax.diagnostic}`;
        }
        publish({ type: 'log', title: 'Rejected staged syntax', detail: `${path} · ${syntax.diagnostic}` });
      } else {
        publish({ type: 'log', title: 'Staged edit', detail: path });
      }
    }
    const snapshot = draft.snapshot();
    const changed = edits.some((entry) => entry.changed);
    if (failedSyntax && !changed) invalidBatches.set(draft, { body, digest: snapshot.digest });
    else invalidBatches.delete(draft);
    if (changed) publish({ type: 'draft', snapshot });
    return { edits, files: snapshot.files.map((file) => file.path) };
  }
  return [
    tool('read_selection', 'Read the currently selected text, including any staged changes.', {}, [], handle('Selection', async (run) => {
      const { selection, draft } = run;
      if (!selection) throw new Error('This session has no selected range.');
      const document = await draft.readSelection();
      publish({ type: 'log', title: 'Read selection', detail: selection.path });
      return { path: selection.path, startLine: document.startLine, selection: document.text, reviewFeedback: run.revisionFeedback };
    })),
    tool('search_workspace', 'Find relevant tracked source, tests and documentation. Search for the feature and working analogues.',
      { query: string, refresh: refreshFlag }, ['query'], handle('Search', (run, args) => {
        const query = typeof args.query === 'string' ? args.query.trim().slice(0, 650) : '';
        return discover(run, 'Search', query, args.refresh, async () => {
          const result = await run.workspace.search(query, { budget: 1600, limit: 5 });
          publish({ type: 'context', ...result, label: 'Search results' });
          return result;
        }, (result) => ({
          matches: result.entries.slice(0, 3).map(({ path, start, end }) => ({ path, start, end })),
        }));
      }, false)),
    tool('read_excerpt', 'Read a short one-based range from a relative workspace path. Read source before modifying it.',
      { path: string, start: integer, end: integer, refresh: refreshFlag }, [], handle('Read', (run, args) => {
        const path = typeof args.path === 'string' ? args.path : '';
        const start = args.start ?? 1;
        const end = Math.min(args.end ?? start + 39, start + 64);
        return discover(run, 'Read', [sourceKey(path), start, end], args.refresh, async () => {
          if (!path.trim()) throw new Error('Provide the path string from a retrieved file. Example fields are path, start and end.');
          const result = await run.workspace.read(path, start, end, 1700, await stagedText(run, path));
          publish({ type: 'log', title: 'Read excerpt', detail: `${result.path}:${result.start}–${result.end}` });
          return result;
        }, ({ path, start, end }) => ({ path, start, end }));
      }, false)),
    tool('outline_file', 'Locate named definitions and documentation sections in a long file before reading precise lines.',
      { path: string, query: string, refresh: refreshFlag }, ['path'], handle('Outline', (run, args) => {
        const path = typeof args.path === 'string' ? args.path : '';
        const query = typeof args.query === 'string' ? args.query.trim().slice(0, 650) : '';
        return discover(run, 'Outline', [sourceKey(path), query], args.refresh, async () => {
          const outline = await run.workspace.outline(path, 1200, query, await stagedText(run, path));
          publish({ type: 'log', title: 'Loaded file outline', detail: outline.path });
          return outline;
        }, (result) => ({
          path: result.path, symbols: result.symbols.slice(0, 3).map(({ name, line }) => ({ name, line })),
        }));
      }, false), { deferred: true }),
    tool('stage_edit', 'Stage one exact text substitution in memory. Copy a short unique old anchor from the source, and provide its replacement. No disk writes.',
      { path: string, old: string, new: string }, ['old', 'new'], handle('Stage edit', stage)),
    tool('stage_edits', 'Stage existing-file edits in memory. For before or after, old is the exact reference line including indentation and new contains only the inserted lines. Or supply a one-based line instead of old. Apply line insertions from bottom to top. Append at EOF without a reference line, or replace exact old text.',
      {
        edits: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object',
            properties: { path: string, line: integer, old: string, new: string, operation: { type: 'string', enum: ['replace', 'before', 'after', 'append'] } },
            required: ['path', 'new'],
            additionalProperties: false
          }
        }
      }, ['edits'], handle('Stage edits', (run, args) => {
        const pending = (run.staging ?? Promise.resolve()).then(() => stageBatch(run, args));
        run.staging = pending.catch(() => {});
        return pending;
      })),
    tool('check_changes', 'Parse staged Python files without importing or executing them and list draft files. Use this before review.',
      {}, [], handle('Check draft', async (run) => {
        const snapshot = run.draft.snapshot();
        const files = await Promise.all(snapshot.files.map(async ({ path }) => run.draft.read(path)));
        const syntax = await pythonSyntax(run.root, run.settings, files, run.signal);
        publish({ type: 'log', title: 'Draft syntax', detail: syntax.diagnostic || syntax.detail || syntax.status });
        return { files: snapshot.files.map((file) => file.path), syntax };
      })),
    tool('review_changes', 'Request human review of the finished staged edits. Wait for the result before saying edits were applied.',
      {}, [], handle('Review', async (run) => {
        const decision = run.reviewDecision;
        if (!decision || run.committed) throw new Error('An active editor approval is required.');
        run.reviewDecision = null;
        const result = await review.apply(run.draft, decision);
        run.committed = true;
        const verification = decision.verification;
        publish({ type: 'applied', ...result, verification });
        return { status: 'applied_to_editor', ...result, draftDigest: decision.digest, verification };
      }), { approval: true }),
    tool('run_command', 'Run a read-only Git inspection in the workspace. Available operations are status and diff_stat.',
      { operation: { type: 'string', enum: ['status', 'diff_stat'] } }, ['operation'], handle('Command', async (run, args) => {
        const argv = args.operation === 'status' ? ['status', '--short'] :
          args.operation === 'diff_stat' ? ['diff', '--stat', '--no-ext-diff', '--no-textconv'] : null;
        if (!argv) throw new Error('Choose status or diff_stat.');
        const result = await limitedProcess('git', [
          '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', run.root, ...argv
        ], { cwd: __dirname, signal: run.signal });
        publish({ type: 'log', title: `git ${argv.join(' ')}`, detail: result.output.trim() || '(no output)' });
        return result;
      }))
  ];
}

module.exports = { editorTools, limitedProcess, pythonSyntax };
