'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createHarness, TrueForgeError } = require('../src/harness');

const sessionId = 'real-session';
const turnId = 'real-turn';
const toolCallId = 'real-tool-call';
const inputSchema = { type: 'object', properties: {}, additionalProperties: false };

function sendJson(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

async function mockTrueForge(t, onRequest = () => {}, tools = []) {
  const history = [];
  let manifest;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      const key = request.method + ' ' + request.url;
      history.push({ key, body });
      if (key === 'PUT /api/v1/settings/mcp-servers') {
        manifest = body.manifest;
        sendJson(response, { data: { name: manifest.name } });
      } else if (key === 'POST /api/v1/sessions') {
        sendJson(response, { data: { id: sessionId } });
      } else if (key === 'DELETE /api/v1/settings/mcp-servers/' + manifest.name) {
        sendJson(response, { data: {} });
      } else if (!(await onRequest(key, response, body))) {
        sendJson(response, { message: 'Unrecognized path' }, 404);
      }
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const harness = await createHarness({ baseUrl, tools });
  t.after(async () => {
    await harness.close();
    await new Promise((resolve) => server.close(resolve));
  });
  function callMcp(method, params, { headers = {}, authorize = true } = {}) {
    return fetch(manifest.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorize && manifest.auth.headers),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }
  return { harness, history, callMcp, baseUrl };
}

test('provisions an authenticated, scoped MCP connector with selective deferral', async (t) => {
  const calls = [];
  const tools = [
    { name: 'read_excerpt', description: 'Read', inputSchema, handler: async () => 'excerpt' },
    { name: 'outline_file', description: 'Outline', inputSchema, deferred: true, handler: async () => 'outline' },
    {
      name: 'review_changes',
      description: 'Review a draft',
      inputSchema,
      approval: true,
      handler: async (args, context) => {
        calls.push(context.sessionId);
        return { active: context.isActive(), marker: args.marker };
      },
    },
  ];
  const { harness, history, callMcp } = await mockTrueForge(t, undefined, tools);
  assert.equal(await harness.createSession({ model: 'another/alias' }), sessionId);
  const { spec } = history[1].body.agent;
  assert.equal(spec.model.name, 'another/alias');
  assert.equal(spec.mcp_servers[0].preload, false);
  assert.deepEqual(spec.mcp_servers[0].preload_tools, ['read_excerpt', 'review_changes']);
  assert.deepEqual(spec.mcp_servers[0].require_approval_for_tools, ['review_changes']);
  assert.equal(new URL(history[0].body.manifest.url).hostname, '127.0.0.1');
  const parameters = { name: 'review_changes', arguments: { marker: 'harmless' } };
  const headers = { 'X-TFG-Session-Id': sessionId };
  assert.equal((await callMcp('tools/call', parameters, { headers, authorize: false })).status, 403);
  assert.equal((await callMcp('tools/call', parameters, {
    headers: { ...headers, Origin: 'https://example.com' },
  })).status, 403);
  assert.equal((await (await callMcp('tools/call', parameters)).json()).result.isError, true);
  assert.equal((await (await callMcp('tools/call', parameters, {
    headers: { 'X-TFG-Session-Id': 'other-session' },
  })).json()).result.isError, true);
  assert.deepEqual(calls, []);
  const response = await (await callMcp('tools/call', parameters, { headers })).json();
  assert.deepEqual(JSON.parse(response.result.content[0].text), { active: true, marker: 'harmless' });
  assert.deepEqual(calls, [sessionId]);
  harness.releaseSession(sessionId);
  assert.equal((await (await callMcp('tools/call', parameters, { headers })).json()).result.isError, true);
  assert.deepEqual(calls, [sessionId]);
});

test('reads fragmented SSE, returns the terminal state, and approves on the same turn', async (t) => {
  let stream;
  const { harness, history, baseUrl } = await mockTrueForge(t, async (key, response) => {
    if (key === `POST /api/v1/sessions/${sessionId}/turns`) {
      stream = response;
      stream.writeHead(200, { 'Content-Type': 'text/event-stream' });
      stream.write(`: ping\r\n\r\ndata: ${JSON.stringify({ type: 'turn.created', turn_id: turnId })}\r\n\r\n`);
      const delta = Buffer.from('data: {"type":"model.message.delta","content":"✓"}\r\n\r\n');
      const mark = delta.indexOf(Buffer.from('✓'));
      stream.write(delta.subarray(0, mark + 1));
      await new Promise((resolve) => setImmediate(resolve));
      stream.write(delta.subarray(mark + 1));
      stream.write(`data: ${JSON.stringify({
        type: 'tool.approval_required', tool_calls: [{ id: toolCallId }], thread_id: 'main',
      })}\n\n`);
      stream.write('data: {"type":"turn.update","state":{"status":"paused"}}\n\n');
      return true;
    }
    if (key === `POST /api/v1/sessions/${sessionId}/turns/${turnId}/events`) {
      sendJson(response, { data: {} });
      stream.end('data: {"type":"turn.done","state":{"status":"done"}}\n\n');
      return true;
    }
    return false;
  });
  await harness.createSession();
  const path = `/sessions/${sessionId}`;
  assert.equal(harness.sessionUrl(sessionId), baseUrl + path);
  const events = [];
  const outcome = await harness.streamTurn(sessionId, 'Keep my exact prompt.', async (event) => {
    events.push(event);
    if (event.type === 'turn.update') {
      await harness.approve(sessionId, events[0].turn_id,
        [{ toolCallId, threadId: 'main', status: 'allow' }]);
    }
  });
  assert.equal(events[1].content, '✓');
  assert.deepEqual(outcome, { turnId, state: { status: 'done' } });
  assert.deepEqual(history[2].body.input, [{ type: 'user.message', content: 'Keep my exact prompt.' }]);
  assert.deepEqual(history[3], {
    key: `POST /api/v1${path}/turns/${turnId}/events`,
    body: { events: [{ type: 'user.tool_approval', thread_id: 'main', tool_call_id: toolCallId,
      approval: { status: 'allow' } }] },
  });
});

test('reports terminal provider failures and distinguishes an incomplete transport', async (t) => {
  let attempt = 0;
  const { harness } = await mockTrueForge(t, (key, response) => {
    if (key === `POST /api/v1/sessions/${sessionId}/turns`) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: {"type":"turn.created","turn_id":"${turnId}"}\n\n`);
      response.end(attempt++ === 0
        ? 'data: {"type":"turn.done","state":{"status":"error","message":"Provider unreachable"}}\n\n'
        : '');
      return true;
    }
    if (key === `GET /api/v1/sessions/${sessionId}/turns/${turnId}`) {
      sendJson(response, { data: { state: { status: 'error' } } });
      return true;
    }
    return false;
  });
  await harness.createSession();
  const result = await harness.streamTurn(sessionId, 'Test failure.');
  assert.equal(result.state.status, 'error');
  assert.equal(result.state.message, 'Provider unreachable');
  await assert.rejects(harness.streamTurn(sessionId, 'Test disconnect.'), (error) =>
    error instanceof TrueForgeError && error.turnId === turnId && /closed before/.test(error.message));
  assert.equal((await harness.getTurn(sessionId, turnId)).state.status, 'error');
});

test('cancels through TrueForge and revokes tool access immediately', async (t) => {
  let stream;
  const { harness, callMcp } = await mockTrueForge(t, (key, response) => {
    if (key === `POST /api/v1/sessions/${sessionId}/turns`) {
      stream = response;
      stream.writeHead(200, { 'Content-Type': 'text/event-stream' });
      stream.write(`data: {"type":"turn.created","turn_id":"${turnId}"}\n\n`);
      return true;
    }
    if (key === `POST /api/v1/sessions/${sessionId}/cancel`) {
      sendJson(response, { data: { cancelled: true } });
      stream.end('data: {"type":"turn.done","state":{"status":"cancelled"}}\n\n');
      return true;
    }
    return false;
  }, [{ name: 'read_excerpt', description: 'Read', inputSchema, handler: async () => 'excerpt' }]);
  await harness.createSession();
  const outcome = await harness.streamTurn(sessionId, 'Test cancellation.', async (event) => {
    if (event.type !== 'turn.created') return;
    const result = harness.cancel(sessionId);
    const mcpResponse = await callMcp('tools/call', { name: 'read_excerpt' }, {
      headers: { 'X-TFG-Session-Id': sessionId },
    });
    assert.equal((await mcpResponse.json()).result.isError, true);
    assert.deepEqual(await result, { cancelled: true });
  });
  assert.equal(outcome.state.status, 'cancelled');
  await assert.rejects(harness.streamTurn(sessionId, 'No new turn.'), /inactive/);
});
