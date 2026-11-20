'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify, TextDecoder } = require('node:util');

const execFileAsync = promisify(execFile);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_FILES = 2000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_FILE = 128 * 1024;
const MAX_READ_FILE = 2 * 1024 * 1024;
const MAX_QUERY_TERMS = 36;
const REGISTRATION = /\.(?:add|register|bind|mount|install)(?:_\w+|[A-Z]\w+)\(\s*(?:[\w$]+\s*=\s*)?(?:"([\w-]+)"|'([\w-]+)'|([\w$]+))(?=\s*[,)]|\s*$)/;
const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__',
  '.cache', '.mypy_cache', '.pytest_cache', '.tox', 'vendor', 'dist', 'coverage',
]);
const TEXT_EXTENSIONS = new Set([
  '.py', '.pyi', '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.rb', '.java', '.kt', '.go', '.rs', '.cs', '.php', '.cpp', '.c', '.h', '.hpp',
  '.sql', '.md', '.rst', '.adoc', '.txt', '.toml', '.ini', '.cfg', '.json',
  '.yaml', '.yml', '.xml', '.html', '.css', '.scss', '.sh', '.ps1', '.bat', '.cmd',
  '.proto', '.graphql', '.feature', '.gradle', '.ex', '.exs', '.lua',
  '.swift', '.scala', '.dart', '.r', '.jl', '.zig', '.cmake', '.conf',
]);
const STOP = new Set(('a an and any as at be by can do for from had has have how i in is it its ' +
  'must of on or our should that the their them this to us use using was were what when where which ' +
  'who why will while with would you your include ensure add find show update each only new also all').split(' '));

function normalizedPath(target) {
  if (typeof target !== 'string' || !target || /[\u0000-\u001f]/.test(target)) {
    throw new Error('Provide a non-empty workspace-relative path.');
  }
  const portable = target.replaceAll('\\', '/');
  const relative = portable.startsWith('./') ? portable.slice(2) : portable;
  if (relative.startsWith('/') || relative.includes(':') ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Paths must stay within the workspace.');
  }
  return relative;
}

function isSourcePath(relative) {
  const parts = relative.toLowerCase().split('/');
  const name = parts.at(-1);
  if (parts.some(part => EXCLUDED_DIRS.has(part)) ||
      /^(?:\.env(?:\.|$)|(?:credentials|secrets)(?:[._-]|$)|\.npmrc$|\.pypirc$|\.netrc$|\.git-credentials$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/.test(name) ||
      /(?:\.lock|package-lock\.json|\.min\.[^.]+|\.pem|\.key|\.pfx|\.p12)$/.test(name)) {
    return false;
  }
  return TEXT_EXTENSIONS.has(path.extname(name)) ||
    ['makefile', 'dockerfile', 'license', 'readme', 'gemfile', 'procfile'].includes(name);
}

function pathKey(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

function isWithin(root, absolute) {
  const relative = path.relative(root, absolute);
  return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative);
}

function roleFor(filename) {
  const parts = filename.toLowerCase().split('/');
  const name = parts.at(-1);
  if (parts.some(part => /^(?:tests?|__tests__|specs?)$/.test(part)) ||
      hasTestName(name)) return 'test';
  if (parts.some(part => /^(?:docs?|documentation|guides?)$/.test(part)) ||
      /\.(?:rst|md|adoc)$/.test(name)) return 'documentation';
  return 'implementation';
}

function hasTestName(name) {
  return /^(?:test|spec)[_.-]|[_.-](?:test|spec)\./.test(name);
}

function fileWords(filename) {
  const basename = path.posix.basename(filename, path.posix.extname(filename)).toLowerCase();
  return words(basename.replace(/^(?:test|spec)[_.-]|[_.-](?:test|spec)$/g, ''));
}

function words(source) {
  const list = source.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase().match(/[\p{L}\d]+/gu) ?? [];
  return list.filter(word => word.length >= 2 && !STOP.has(word)).map(word => {
    if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.length > 4 && /[^sui]s$/.test(word)) return word.slice(0, -1);
    return word;
  });
}

function getSymbols(lines, filename) {
  const markdown = /\.(?:md|adoc)$/i.test(filename);
  const restructuredText = /\.rst$/i.test(filename);
  const result = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    const declaration = trimmed.match(/^(?:(?:export|default|async|declare|pub|public|private|protected|static|abstract)\s+)*(?:def|class|interface|trait|struct|enum|type|function|func|fn|module|sub)\s+([\p{L}_$][\p{L}\d_$]*)\b/u);
    const assignment = trimmed.match(/^(?:(?:export\s+)?(?:const|let|var)\s+)?([A-Z][A-Z\d_]{2,})\s*(?::[^=]+)?\s*=/u);
    const heading = (markdown && trimmed.match(/^#{1,6}\s+([^#].+?)\s*#*$/)) ||
      (restructuredText && trimmed && /^([=~^*-])\1{2,}$/.test(lines[index + 1]?.trim() ?? '') &&
        !/^\W+$/u.test(trimmed) ? [null, trimmed] : null);
    const match = declaration ?? assignment ?? heading;
    if (match) result.push({ name: match[1], line: index + 1, signature: trimmed.slice(0, 150) });
  }
  return result;
}

function utf8Size(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function trimSerialized(value, key, budget) {
  if (utf8Size(value) <= budget) return value;
  const chars = Array.from(value[key]);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Size({ ...value, [key]: chars.slice(0, middle).join('') }) <= budget) low = middle;
    else high = middle - 1;
  }
  return { ...value, [key]: chars.slice(0, low).join('') };
}

function packetBytes(packet) {
  packet.bytes = utf8Size(packet);
  packet.bytes = utf8Size(packet);
  return packet;
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function getMentions(input) {
  const found = /@(file|symbol):(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;]+))/giu;
  const mentions = [];
  for (const match of input.matchAll(found)) {
    const kind = match[1].toLowerCase();
    const value = (match[2] ?? match[3] ?? match[4]).slice(0, 220);
    if (!mentions.some(item => item.kind === kind && item.value === value)) mentions.push({ kind, value });
    if (mentions.length === 8) break;
  }
  return { mentions, query: input.replace(found, ' ') };
}

function interfaceTerms(query) {
  if (/\b(?:cli|command[ -]line)\b/i.test(query)) return new Set(['cli', 'command']);
  if (/\b(?:http|web)\s+(?:endpoint|route|handler)\b/i.test(query)) return new Set(['route', 'handler', 'endpoint']);
  return new Set();
}

class Workspace {
  static async open(directory, options = {}) {
    const root = await fs.realpath(directory);
    const workspace = new Workspace(root, options);
    await workspace.refresh();
    return workspace;
  }

  constructor(root, { readBuffer = async () => undefined, openPaths = () => [] } = {}) {
    this.root = root;
    this.readBuffer = readBuffer;
    this.openPaths = openPaths;
    this.tracked = new Map();
    this.indexCache = new Map();
  }

  async refresh() {
    let entries;
    try {
      const { stdout } = await execFileAsync('git', ['-C', this.root, 'ls-files', '--cached', '-z'], {
        windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      });
      entries = stdout.split('\0').filter(Boolean);
    } catch (error) {
      if (error.code !== 128 || !/not a git repository/i.test(error.stderr ?? '')) {
        throw new Error('Could not read the workspace Git index.', { cause: error });
      }
      entries = [];
    }
    this.tracked = new Map(entries.filter(isSourcePath).map(relative => [pathKey(relative), relative]));
  }

  async knownPaths() {
    const paths = new Map(this.tracked);
    for (const absolute of await this.openPaths()) {
      if (!isWithin(this.root, absolute)) continue;
      const relative = path.relative(this.root, absolute).split(path.sep).join('/');
      if (isSourcePath(relative)) paths.set(pathKey(relative), relative);
    }
    return paths;
  }

  async resolve(relative, allowedPaths) {
    const requested = normalizedPath(relative);
    if (!isSourcePath(requested)) throw new Error('This file is excluded from source context.');
    const files = allowedPaths ?? await this.knownPaths();
    const known = files.get(pathKey(requested));
    if (!known) throw new Error('File must be tracked or open in this workspace: ' + requested);
    const candidate = path.join(this.root, known);
    let real;
    try {
      real = await fs.realpath(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Workspace file is missing: ' + known);
      throw error;
    }
    if (!isWithin(this.root, real) || pathKey(real) !== pathKey(candidate)) {
      throw new Error('Workspace source must be a regular file without symbolic links.');
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error('Workspace source must be a regular file.');
    return real;
  }

  async readText(relative, textOverride) {
    const absolutePath = await this.resolve(relative);
    const text = typeof textOverride === 'string' ? textOverride : await this.sourceText(absolutePath, MAX_READ_FILE);
    if (typeof textOverride === 'string' &&
        (text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAX_READ_FILE)) {
      throw new Error('Staged source is binary or exceeds the source-size limit.');
    }
    return { path: path.relative(this.root, absolutePath).split(path.sep).join('/'), text, absolutePath };
  }

  async sourceText(absolute, maximum) {
    const openText = await this.readBuffer(absolute);
    if (typeof openText === 'string') {
      if (openText.includes('\0') || Buffer.byteLength(openText, 'utf8') > maximum) {
        throw new Error('Workspace buffer is binary or exceeds the source-size limit.');
      }
      return openText;
    }
    const file = await fs.open(absolute, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximum) throw new Error('Workspace file exceeds the source-size limit.');
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      const contents = buffer.subarray(0, size);
      if (size > stat.size || contents.includes(0)) throw new Error('Workspace file is binary or changed during the read.');
      return utf8.decode(contents);
    } finally {
      await file.close();
    }
  }

  async index(mentioned = []) {
    const known = await this.knownPaths();
    const priority = mentioned.map(value => {
      try { return known.get(pathKey(normalizedPath(value))); } catch { return undefined; }
    }).filter(Boolean);
    const files = [...new Set([...priority, ...known.values()])];
    const docs = [];
    let totalBytes = 0;
    for (let i = 0; i < Math.min(files.length, MAX_FILES) && totalBytes < MAX_INDEX_BYTES; i += 16) {
      const batch = await Promise.all(files.slice(i, i + 16).map(relative => this.indexFile(relative, known)));
      for (const entry of batch) {
        if (!entry || totalBytes + entry.bytes > MAX_INDEX_BYTES) continue;
        docs.push(entry);
        totalBytes += entry.bytes;
      }
    }
    return { docs, known, skipped: files.length - docs.length };
  }

  async indexFile(relative, known) {
    try {
      const absolute = await this.resolve(relative, known);
      const buffer = await this.readBuffer(absolute);
      const stat = typeof buffer === 'string' ? undefined : await fs.stat(absolute);
      const stamp = stat ? `${stat.mtimeMs}/${stat.ctimeMs}/${stat.size}` : undefined;
      const cached = this.indexCache.get(relative);
      if (stamp && cached?.stamp === stamp) return cached.entry;
      const text = typeof buffer === 'string' ? buffer : await this.sourceText(absolute, MAX_INDEX_FILE);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_INDEX_FILE || text.includes('\0')) return undefined;
      const lines = text.split(/\r\n|\n|\r/);
      const lineWords = lines.map(words);
      const frequencies = new Map();
      let length = 0;
      for (const tokens of lineWords) {
        for (const term of tokens) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
        length += tokens.length;
      }
      const entry = {
        relative, bytes, lines, lineWords, frequencies, length, role: roleFor(relative),
        filenameWords: fileWords(relative), symbols: getSymbols(lines, relative),
      };
      if (stamp) this.indexCache.set(relative, { stamp, entry });
      else this.indexCache.delete(relative);
      return entry;
    } catch (error) {
      if (error instanceof Error) return undefined;
      throw error;
    }
  }

  async context(instruction, { budget = 2400, limit = 5 } = {}) {
    return this.rank(instruction, budget, limit, true);
  }

  async search(query, { budget = 1800, limit = 5 } = {}) {
    return this.rank(query, budget, limit, false);
  }

  async rank(input, requestedBudget, requestedLimit, includeRoleHints) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Enter a non-empty search instruction.');
    const budget = boundedInteger(requestedBudget, 2400, 160, 5200);
    const limit = boundedInteger(requestedLimit, 5, 1, 12);
    const { mentions, query } = getMentions(input.slice(0, 12000));
    const { docs, known, skipped } = await this.index(mentions.filter(item => item.kind === 'file').map(item => item.value));
    const queryWords = words(query).slice(0, MAX_QUERY_TERMS * 2);
    const queryTerms = [...new Set(queryWords)].slice(0, MAX_QUERY_TERMS);
    const surfaces = interfaceTerms(query);
    const phrases = new Set(queryWords.slice(1).map((term, index) => queryWords[index] + ' ' + term));
    const integrationIntent = /(?:\bbuilt[ -]in\b|\bregist(?:er|ration)\b|--help\b)/i.test(query);
    const idf = new Map(queryTerms.map(term => {
      const hits = docs.reduce((count, doc) => count + Number(doc.frequencies.has(term)), 0);
      return [term, Math.log(1 + (docs.length - hits + 0.5) / (hits + 0.5))];
    }));
    const average = docs.reduce((total, doc) => total + doc.length, 0) / (docs.length || 1) || 1;
    const lexical = docs.map(doc => {
      let score = 0;
      const matched = [];
      for (const term of queryTerms) {
        const frequency = doc.frequencies.get(term) ?? 0;
        const filenameHit = doc.filenameWords.includes(term);
        if (frequency || filenameHit) matched.push(term);
        const weight = idf.get(term);
        if (frequency) score += weight * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / average));
        if (filenameHit) score += Math.min(weight, 3) * 1.8;
        if (filenameHit && surfaces.has(term)) score += 7;
      }
      const declarations = new Set();
      for (const symbol of doc.symbols) {
        const tokens = words(symbol.name);
        for (let index = 1; index < tokens.length; index++) {
          const phrase = tokens[index - 1] + ' ' + tokens[index];
          if (phrases.has(phrase)) declarations.add(phrase);
        }
      }
      score += Math.min(18, declarations.size * 12);
      const reason = [
        declarations.size ? 'Declaration matches ' + [...declarations].slice(0, 2).join(', ') + '.' : '',
        matched.length ? 'Matches ' + matched.slice(0, 6).join(', ') + '.' : '',
      ].filter(Boolean).join(' ');
      return { doc, score, reason };
    }).filter(item => item.score > 0).sort((left, right) =>
      right.score - left.score || left.doc.relative.localeCompare(right.doc.relative));
    const { explicit, reports } = this.resolveMentions(mentions, docs, known);
    const ordered = [...explicit];
    const implementation = lexical.find(item => item.doc.role === 'implementation');
    if (includeRoleHints && implementation && queryTerms.length) {
      ordered.push(implementation);
      const stem = implementation.doc.filenameWords.join(' ');
      for (const role of ['test', 'documentation']) {
        const sibling = stem && lexical.find(item => item.doc.role === role &&
          item.doc.filenameWords.join(' ') === stem &&
          (role !== 'test' || hasTestName(path.posix.basename(item.doc.relative).toLowerCase())));
        const chosen = sibling ?? lexical.find(item => item.doc.role === role);
        if (chosen) ordered.push(sibling ? {
          ...chosen, reason: 'Related ' + role + ' name for ' + implementation.doc.relative + '.',
        } : chosen);
      }
    }
    ordered.push(...lexical);
    const unique = new Map();
    for (const item of ordered) {
      if (!unique.has(item.doc.relative)) unique.set(item.doc.relative, item);
    }
    const candidates = [...unique.values()];
    const packet = packetBytes({
      entries: [], mentions: [], bytes: 0, budget, omitted: candidates.length, skipped,
    });
    for (const report of reports) {
      packet.mentions.push(report);
      if (packetBytes(packet).bytes > Math.min(budget - 95, Math.ceil(budget * 0.55))) {
        packet.mentions.pop();
        break;
      }
    }
    packetBytes(packet);
    const targetCount = Math.min(candidates.length, limit);
    const implementationLine = implementation && bestLine(implementation.doc, idf, surfaces, phrases, integrationIntent);
    const analogues = integrationIntent && implementationLine
      ? registrationNames(implementation.doc.lines.slice(Math.max(0, implementationLine - 8), implementationLine + 7))
      : new Set();
    let linkedExcerpt = false;
    let linkConsidered = false;
    for (const item of candidates) {
      if (packet.entries.length >= limit) break;
      const available = budget - packet.bytes;
      const share = Math.ceil(available / Math.max(1, targetCount - packet.entries.length));
      const center = item.line ?? (item === implementation ? implementationLine :
        bestLine(item.doc, idf, surfaces, phrases, integrationIntent, analogues));
      const entry = excerptAround(item.doc, center, item.reason, Math.max(175, share - 6));
      packet.entries.push(entry);
      packet.omitted = candidates.length - packet.entries.length + Number(linkedExcerpt);
      if (packetBytes(packet).bytes > budget) {
        packet.entries.pop();
        packet.omitted = candidates.length - packet.entries.length + Number(linkedExcerpt);
        packetBytes(packet);
      }
      if (!linkConsidered && includeRoleHints && integrationIntent && implementation && packet.entries.length < targetCount &&
          new Set(packet.entries.map(candidate => candidate.role)).size === 3) {
        linkConsidered = true;
        const available = budget - packet.bytes;
        const remainingSlots = targetCount - packet.entries.length;
        const linkedBudget = Math.min(790, available - (remainingSlots > 1 ? 170 : 0));
        const linked = registeredDefinition(implementation.doc, packet.entries, linkedBudget);
        if (linked) {
          packet.entries.push(linked);
          if (packetBytes(packet).bytes <= budget) {
            linkedExcerpt = true;
            if (packet.entries.length < targetCount) {
              const site = packet.entries.find(entry => entry.path === implementation.doc.relative);
              const initializer = moduleInitializer(implementation.doc, site, budget - packet.bytes);
              if (initializer) {
                packet.entries.push(initializer);
                if (packetBytes(packet).bytes > budget) packet.entries.pop();
                packetBytes(packet);
              }
            }
          }
          else {
            packet.entries.pop();
            packetBytes(packet);
          }
        }
      }
    }
    return packet;
  }

  resolveMentions(mentions, docs, known) {
    const explicit = [];
    const reports = [];
    for (const mention of mentions) {
      let matches = [];
      let unavailable = false;
      if (mention.kind === 'file') {
        try {
          const relative = known.get(pathKey(normalizedPath(mention.value)));
          matches = docs.filter(doc => doc.relative === relative).map(doc => ({ doc, line: 1 }));
          unavailable = Boolean(relative) && matches.length === 0;
        } catch {}
      } else {
        const simpleName = mention.value.split('.').at(-1);
        matches = docs.flatMap(doc => doc.symbols.filter(symbol => symbol.name === simpleName)
          .map(symbol => ({ doc, line: symbol.line })));
      }
      const status = matches.length === 1 ? 'resolved' : matches.length > 1 ? 'ambiguous' : unavailable ? 'unavailable' : 'missing';
      reports.push({
        ...mention, status, matches: matches.slice(0, 4).map(item => ({ path: item.doc.relative, line: item.line })),
      });
      for (const match of matches.slice(0, 3)) {
        explicit.push({
          ...match, kind: mention.kind, reason: `@${mention.kind} ${status === 'ambiguous' ? 'candidate' : 'match'}.`,
        });
      }
    }
    explicit.sort((left, right) => Number(right.kind === 'symbol') - Number(left.kind === 'symbol'));
    return { explicit, reports };
  }

  async read(relative, start = 1, end, requestedBudget = 2600, textOverride) {
    const file = await this.readText(relative, textOverride);
    const lines = file.text.split(/\r\n|\n|\r/);
    if (!Number.isSafeInteger(start) || start < 1 || start > lines.length ||
        (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
      throw new Error('Use a one-based line range within the file.');
    }
    const requestedEnd = end ?? start + 39;
    const last = Math.min(lines.length, requestedEnd, start + 79);
    const budget = boundedInteger(requestedBudget, 2600, 380, 5200);
    const result = {
      path: file.path, start, end: start, excerpt: '',
      reason: 'Requested file range.', truncated: last < requestedEnd && last < lines.length,
    };
    for (let line = start; line <= last; line++) {
      const excerpt = lines.slice(start - 1, line).join('\n');
      const next = { ...result, end: line, excerpt };
      if (utf8Size(next) > budget) {
        return trimSerialized({ ...result, truncated: true, excerpt: line === start ? lines[start - 1] : result.excerpt },
          'excerpt', budget);
      }
      result.end = line;
      result.excerpt = excerpt;
    }
    return result;
  }

  async outline(relative, requestedBudget = 2200, query, textOverride) {
    const file = await this.readText(relative, textOverride);
    const lines = file.text.split(/\r\n|\n|\r/);
    const symbols = getSymbols(lines, file.path);
    if (typeof query === 'string' && query.trim()) {
      const terms = new Set(words(query.slice(0, 650)));
      const rank = (symbol) => words(symbol.name).reduce((score, term) => score + (terms.has(term) ? 2 : 0), 0) +
        words(symbol.signature).reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0);
      symbols.sort((left, right) => rank(right) - rank(left) || left.line - right.line);
    }
    const budget = boundedInteger(requestedBudget, 2200, 380, 5200);
    const result = { path: file.path, symbols: [], omitted: symbols.length };
    for (const symbol of symbols) {
      result.symbols.push(symbol);
      result.omitted--;
      if (utf8Size(result) > budget) {
        result.symbols.pop();
        result.omitted++;
        break;
      }
    }
    return result;
  }
}

function registrationNames(lines) {
  const result = new Set();
  for (const line of lines) {
    const match = line.match(REGISTRATION);
    if (!match) continue;
    const name = (match[1] ?? match[2] ?? match[3]).replace(/_(?:command|handler|route|hook|callback)$/i, '');
    for (const part of words(name)) result.add(part);
  }
  return result;
}

function registeredDefinition(doc, entries, budget) {
  const site = entries.find(entry => entry.path === doc.relative);
  if (!site || budget < 200) return undefined;
  const testWords = new Set(words(entries.find(entry => entry.role === 'test')?.excerpt ?? ''));
  const guideWords = new Set(words(entries.find(entry => entry.role === 'documentation')?.excerpt ?? ''));
  const linked = [];
  for (const [offset, line] of site.excerpt.split('\n').entries()) {
    if (/^\s*(?:#|\/\/|\/\*)/.test(line)) continue;
    const name = line.match(REGISTRATION)?.[3];
    if (!name) continue;
    const declarations = doc.symbols.filter(symbol => symbol.name === name);
    if (declarations.length !== 1) continue;
    const [declaration] = declarations;
    if (declaration.line >= site.start && declaration.line <= site.end) continue;
    const terms = words(name.replace(/_(?:command|handler|route|hook|callback)$/i, ''));
    const score = terms.reduce((sum, term) => sum + 3 * Number(testWords.has(term)) + Number(guideWords.has(term)), 0);
    linked.push({ declaration, line: site.start + offset, score });
  }
  const match = linked.sort((left, right) => right.score - left.score || left.line - right.line)[0];
  if (!match) return undefined;
  const { declaration, line } = match;
  const reason = `Definition of ${declaration.name} registered at line ${line}.`;
  let start = declaration.line;
  for (let cursor = declaration.line - 2; cursor >= Math.max(0, declaration.line - 19); cursor--) {
    const text = doc.lines[cursor];
    if (!text.trim()) break;
    if (text.trimStart().startsWith('@')) start = cursor + 1;
    else if (!/^(?:\s+|[\])}])/.test(text)) break;
  }
  for (let end = Math.min(declaration.line + 2, doc.lines.length); end >= declaration.line; end--) {
    const entry = {
      path: doc.relative, start, end, excerpt: doc.lines.slice(start - 1, end).join('\n'), reason, role: doc.role,
    };
    if (utf8Size(entry) <= budget - 4) return entry;
  }
  if (utf8Size({ path: doc.relative, start: declaration.line, end: declaration.line, excerpt: doc.lines[declaration.line - 1],
    reason, role: doc.role }) > budget - 4) return undefined;
  return excerptAround(doc, declaration.line, reason, budget - 4);
}

function moduleInitializer(doc, site, budget) {
  if (!doc.relative.endsWith('.py') || !site || budget < 140) return undefined;
  const owner = doc.symbols.findLast(symbol => symbol.line <= site.start &&
    /^class [A-Za-z_]\w*\b/.test(doc.lines[symbol.line - 1]));
  if (!owner) return undefined;
  const construction = new RegExp(`^[A-Za-z_]\\w*\\s*=\\s*${owner.name}\\s*\\(`);
  const matches = doc.lines.flatMap((line, index) => construction.test(line) ? [index + 1] : []);
  if (matches.length !== 1 || matches[0] <= site.end) return undefined;
  const [line] = matches;
  const reason = `Constructs ${owner.name} at module load.`;
  const entry = { path: doc.relative, start: line, end: line, excerpt: doc.lines[line - 1], reason, role: doc.role };
  return utf8Size(entry) <= budget - 3 ? excerptAround(doc, line, reason, budget - 3) : undefined;
}

function bestLine(doc, weights, surfaces, phrases, integrationIntent, analogues = new Set()) {
  const structural = new Set(doc.symbols.map(symbol => symbol.line));
  const scores = doc.lineWords.map((terms, index) => {
    const words = new Set(terms);
    const hits = [...words].reduce((sum, term) => sum + (weights.get(term) ?? 0) + (surfaces.has(term) ? 1.2 : 0), 0);
    const line = doc.lines[index];
    const registration = integrationIntent && doc.role === 'implementation' && REGISTRATION.test(line);
    const invokes = integrationIntent && doc.role === 'test' && /\binvoke\(/.test(line);
    const shellExample = doc.role === 'documentation' && /^\s*[$>]\s+\S+\s+\S/.test(line);
    const documentationHeading = doc.role === 'documentation' && structural.has(index + 1);
    const linkedExample = (invokes || shellExample || documentationHeading) && terms.some((term) => analogues.has(term));
    if (!hits && !linkedExample && !registration) return 0;
    const phraseBonus = terms.slice(1).some((term, position) => phrases.has(terms[position] + ' ' + term)) ? 3 : 0;
    return hits + phraseBonus + (structural.has(index + 1) ? 2.2 : 0) +
      (registration ? 14 : 0) + (invokes ? 6 : 0) + (linkedExample ? 16 : 0) +
      (documentationHeading && linkedExample ? 16 : 0);
  });
  let best = 0;
  let bestScore = 0;
  for (const [index, score] of scores.entries()) {
    const window = score + 0.32 * ((scores[index - 1] ?? 0) + (scores[index + 1] ?? 0));
    if (window > bestScore) {
      bestScore = window;
      best = index;
    }
  }
  return best + 1;
}

function excerptAround(doc, center, reason, budget) {
  const entry = {
    path: doc.relative, start: center, end: center, excerpt: doc.lines[center - 1] ?? '', reason, role: doc.role,
  };
  if (utf8Size(entry) > budget) return trimSerialized(entry, 'excerpt', budget);
  for (let distance = 1; distance < 7; distance++) {
    for (const line of [center - distance, center + distance]) {
      if (line !== entry.start - 1 && line !== entry.end + 1) continue;
      if (line < 1 || line > doc.lines.length) continue;
      const start = Math.min(line, entry.start);
      const end = Math.max(line, entry.end);
      const excerpt = doc.lines.slice(start - 1, end).join('\n');
      if (utf8Size({ ...entry, start, end, excerpt }) <= budget) Object.assign(entry, { start, end, excerpt });
    }
  }
  return entry;
}

module.exports = { Workspace };
