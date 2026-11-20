'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const definition = require('../agent/ourloss.json');

const RPC_LIMIT = 384 * 1024;
const EVENT_LIMIT = 2 * 1024 * 1024;
const DEFAULT_BASE_URL = 'http://127.0.0.1:8790';
const REQUEST_TIMEOUT = 10000;

class TrueForgeError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'TrueForgeError';
    this.status = status;
  }
}

function validateBaseUrl(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/'
  ) {
    throw new Error('The TrueForge URL must be the loopback server origin.');
  }
  return url.origin;
}

function writeJson(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(json);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > RPC_LIMIT) {
        reject(Object.assign(new Error('Tool request exceeds the input limit.'), { status: 413 }));
        return;
      }
      parts.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function matchesHeader(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicTool({ name, description, inputSchema, annotations, approval }) {
  return {
    name,
    description,
    inputSchema,
    annotations: { ...annotations, readOnlyHint: !approval },
  };
}

function toolResult(value) {
  if (value && Array.isArray(value.content)) return value;
  return {
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value ?? null),
    }],
  };
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function openMcpServer(tools, sessions, authorization) {
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.origin || !matchesHeader(request.headers.authorization, authorization)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    let message;
    try {
      message = await readJson(request);
    } catch (error) {
      writeJson(response, error.status ?? 400, {
        jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid MCP request body.' },
      });
      return;
    }

    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      writeJson(response, 400, {
        jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request.' },
      });
      return;
    }
    if (!Object.hasOwn(message, 'id')) {
      response.writeHead(202).end();
      return;
    }

    const sessionId = request.headers['x-tfg-session-id'];
    const activeTools = sessions.get(sessionId);
    const reply = (result) => writeJson(response, 200, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      reply({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'OurLoss Workspace', version: '0.1.0' },
      });
    } else if (message.method === 'ping') {
      reply({});
    } else if (message.method === 'tools/list') {
      reply({
        tools: [...tools.values()]
          .filter((tool) => !sessionId || activeTools?.has(tool.name))
          .map(publicTool),
      });
    } else if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const tool = tools.get(name);
      if (!activeTools || !activeTools.has(name) || !tool) {
        reply(toolError('This tool is unavailable for the current TrueForge session.'));
        return;
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        reply(toolError('Expected tool arguments to be a JSON object.'));
        return;
      }
      try {
        reply(toolResult(await tool.handler(args, {
          sessionId,
          isActive: () => sessions.has(sessionId),
        })));
      } catch (error) {
        reply(toolError(String(error?.message ?? error).slice(0, 1800)));
      }
    } else {
      writeJson(response, 200, {
        jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown MCP method.' },
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function parseEvent(frame) {
  const data = frame.split(/\r\n|\r|\n/)
    .filter((line) => line === 'data' || line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data || data === '[DONE]') return undefined;
  try {
    const event = JSON.parse(data);
    if (typeof event?.type !== 'string') throw new Error('Missing event type');
    return event;
  } catch (cause) {
    throw new TrueForgeError('TrueForge returned a malformed stream event.', { cause });
  }
}

async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  const separator = /\r\n\r\n|\n\n|\r\r/;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = separator.exec(buffer))) {
      if (match.index > EVENT_LIMIT) throw new TrueForgeError('TrueForge stream event exceeded its size limit.');
      const event = parseEvent(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (event) yield event;
    }
    if (buffer.length > EVENT_LIMIT) throw new TrueForgeError('TrueForge stream event exceeded its size limit.');
  }
  const final = parseEvent(buffer + decoder.decode());
  if (final) yield final;
}

function matchError(body, status) {
  const value = body?.error?.message ?? body?.error ?? body?.message ?? body?.detail;
  return typeof value === 'string' ? value.slice(0, 700) : `HTTP ${status}`;
}

async function createHarness({
  baseUrl = DEFAULT_BASE_URL,
  model = definition.model.name,
  tools,
} = {}) {
  const origin = validateBaseUrl(baseUrl);
  const api = `${origin}/api/v1`;
  const registeredTools = new Map();
  for (const tool of tools ?? []) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool?.name) ||
      typeof tool.handler !== 'function' || !tool.inputSchema || registeredTools.has(tool.name)) {
      throw new Error('Invalid or duplicate editor MCP tool.');
    }
    registeredTools.set(tool.name, tool);
  }
  const sessions = new Map();
  const connector = `ourloss-editor-${randomBytes(6).toString('hex')}`;
  const token = randomBytes(24).toString('hex');
  const authorization = 'Bearer ' + token;
  const mcp = await openMcpServer(registeredTools, sessions, authorization);

  async function request(method, path, body, { signal, stream = false } = {}) {
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      response = await fetch(api + path, {
        method,
        headers: {
          Accept: stream ? 'text/event-stream' : 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (response.ok && stream) return response;
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = matchError(payload, response.status).replaceAll(token, '[redacted]');
        throw new TrueForgeError(`TrueForge ${method} ${path}: ${message}`, { status: response.status });
      }
      return payload;
    } catch (cause) {
      if (cause instanceof TrueForgeError || signal?.aborted) throw cause;
      const message = controller.signal.aborted
        ? `TrueForge did not respond at ${origin}.`
        : `Could not reach the TrueForge API at ${origin}.`;
      throw new TrueForgeError(message, { cause });
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    await request('PUT', '/settings/mcp-servers', {
      manifest: {
        type: 'remote',
        name: connector,
        description: 'OurLoss workspace evidence, draft edits, and gated hunk review.',
        url: `http://127.0.0.1:${mcp.address().port}/mcp`,
        auth: { type: 'header', headers: { Authorization: authorization } },
      },
    });
  } catch (error) {
    mcp.close();
    throw error;
  }

  const sessionPath = (sessionId) => `/sessions/${encodeURIComponent(sessionId)}`;
  const turnPath = (sessionId, turnId) => `${sessionPath(sessionId)}/turns/${encodeURIComponent(turnId)}`;
  let closed = false;

  return {
    async createSession({
      instructions,
      model: selectedModel = model,
      modelParams,
      config,
      toolNames,
      metadata,
      mode,
      eagerTools = false,
    } = {}) {
      if (closed) throw new TrueForgeError('The editor connection is closed.');
      const enabled = [...new Set(toolNames ?? registeredTools.keys())];
      if (enabled.some((name) => !registeredTools.has(name))) {
        throw new Error('Unknown editor MCP tool in session configuration.');
      }
      const selectedTools = enabled.map((name) => registeredTools.get(name));
      const hasDeferredTools = !eagerTools && selectedTools.some((tool) => tool.deferred);
      const spec = {
        model: { name: selectedModel, params: { ...definition.model.params, ...modelParams } },
        instructions: [definition.instructions, instructions].filter(Boolean).join('\n\n'),
        config: {
          ...definition.config,
          ...(mode === 'inline' && { iteration_limit: 9 }),
          ...config,
        },
        mcp_servers: [{
          ...definition.mcp_servers[0],
          name: connector,
          enable_tools: enabled,
          preload: !hasDeferredTools,
          preload_tools: hasDeferredTools
            ? selectedTools.filter((tool) => !tool.deferred).map((tool) => tool.name)
            : [],
          require_approval_for_tools: selectedTools
            .filter((tool) => tool.approval || definition.mcp_servers[0].require_approval_for_tools.includes(tool.name))
            .map((tool) => tool.name),
        }],
      };
      const response = await request('POST', '/sessions', {
        agent: { spec },
        ...(metadata && { metadata }),
      });
      const sessionId = response?.data?.id;
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new TrueForgeError('TrueForge returned no session ID.');
      }
      sessions.set(sessionId, new Set(enabled));
      return sessionId;
    },

    async streamTurn(sessionId, content, onEvent, { signal } = {}) {
      if (!sessions.has(sessionId)) throw new TrueForgeError('This editor session is inactive.');
      if (typeof content !== 'string' || !content.trim()) throw new Error('A user instruction is required.');
      const response = await request('POST', `${sessionPath(sessionId)}/turns`, {
        input: [{ type: 'user.message', content }],
      }, { signal, stream: true });
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw new TrueForgeError('TrueForge did not return a turn event stream.');
      }
      let turnId;
      try {
        for await (const event of readEvents(response.body)) {
          if (event.type === 'turn.created') turnId = event.turn_id;
          await onEvent?.(event);
          if (event.type === 'turn.done') return { turnId: turnId ?? event.turn_id, state: event.state };
        }
        throw new TrueForgeError('The TrueForge stream closed before the turn finished.');
      } catch (error) {
        if (error instanceof Error) error.turnId = turnId;
        throw error;
      }
    },

    async approve(sessionId, turnId, decisions) {
      if (!sessions.has(sessionId)) throw new TrueForgeError('This editor session is inactive.');
      if (!turnId || !Array.isArray(decisions) || decisions.length === 0 ||
        decisions.some(({ toolCallId, threadId, status }) =>
          !toolCallId || !threadId || !['allow', 'deny'].includes(status))) {
        throw new Error('Native approvals require a turn, thread, tool call and decision.');
      }
      await request('POST', `${turnPath(sessionId, turnId)}/events`, {
        events: decisions.map(({ toolCallId, threadId, status, reason }) => ({
          type: 'user.tool_approval',
          thread_id: threadId,
          tool_call_id: toolCallId,
          approval: { status, ...(status === 'deny' && reason && { reason: String(reason).slice(0, 1000) }) },
        })),
      });
    },

    async cancel(sessionId) {
      sessions.delete(sessionId);
      return (await request('POST', `${sessionPath(sessionId)}/cancel`, {}))?.data;
    },

    async getTurn(sessionId, turnId) {
      return (await request('GET', turnPath(sessionId, turnId)))?.data;
    },

    releaseSession(sessionId) {
      sessions.delete(sessionId);
    },

    sessionUrl(sessionId) {
      return origin + sessionPath(sessionId);
    },

    async close() {
      if (closed) return;
      closed = true;
      sessions.clear();
      mcp.close();
      await request('DELETE', `/settings/mcp-servers/${encodeURIComponent(connector)}`).catch(() => {});
    },
  };
}

module.exports = { createHarness, TrueForgeError };
