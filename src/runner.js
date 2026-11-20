'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { createHarness } = require('./harness');
const { Draft } = require('./review');
const { editorTools, pythonSyntax } = require('./tools');
const { createHash } = require('node:crypto');

const INLINE_TOOLS = ['read_selection', 'stage_edit', 'check_changes', 'review_changes'];
const WORKSPACE_TOOLS = ['search_workspace', 'read_excerpt', 'outline_file', 'stage_edits', 'check_changes', 'review_changes', 'run_command'];

function errorText(error) {
  return String(error?.message ?? error ?? 'Unknown error')
    .replace(/\borg_[A-Za-z0-9]{12,}\b/g, '[account]')
    .replace(/\b(?:gsk_|sk-or-v1-|ghp_)[A-Za-z0-9]{20,}\b/g, '[credential]')
    .slice(0, 1000);
}

function terminalError(state) {
  return errorText(state?.error?.message ?? state?.error ?? state?.message ?? state?.output?.content ?? 'The turn ended unexpectedly.');
}

function modelError(error) {
  const message = errorText(error);
  return /model error|provider|429|401|402|403|timed out|connection refused|ECONNREFUSED|quota|unavailable|overloaded/i.test(message);
}

function rateLimitWait(state) {
  const message = terminalError(state);
  if (state?.status !== 'error' || !/\b429\b/.test(message)) return null;
  const delay = /(?:try again|retry) in\s+(\d+(?:\.\d+)?)s\b/i.exec(message);
  if (!delay || Number(delay[1]) > 60) return null;
  const capacity = /Limit\s+(\d+),\s+Used\s+\d+,\s+Requested\s+(\d+)/i.exec(message);
  if (capacity && Number(capacity[2]) > Number(capacity[1])) return null;
  return Math.ceil(Number(delay[1]) * 1000) + 350;
}

function changesKey(snapshot) {
  const files = snapshot.files.map(({ path, hunks }) => [path, hunks.map((hunk) => [
    hunk.startOffset, hunk.endOffset, hunk.oldText, hunk.newText
  ])]);
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

class Runner {
  constructor({ publish, review }) {
    this.publish = publish;
    this.review = review;
    this.run = null;
    this.harness = null;
    this.origin = '';
  }

  async connect(origin) {
    if (this.harness && this.origin === origin) return;
    await this.harness?.close();
    this.harness = null;
    this.harness = await createHarness({
      baseUrl: origin,
      tools: editorTools((sessionId) => this.run?.sessionId === sessionId ? this.run : undefined, this.review, this.publish)
    });
    this.origin = origin;
  }

  async start({ instruction, selection, workspace, loadDocument, root, settings, readBuffer }) {
    if (this.run) throw new Error('Finish or cancel the active run first.');
    if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('Enter an instruction.');
    const abort = new AbortController();
    const run = { abort, signal: abort.signal, root, workspace, settings, readBuffer, selection, mode: selection ? 'inline' : 'workspace' };
    this.run = run;
    this.publish({ type: 'begin', mode: run.mode, instruction });
    try {
      await this.connect(settings.trueForgeUrl);
      const context = selection ? null : await workspace.context(instruction, { budget: settings.contextBytes, limit: 5 });
      if (context) this.publish({ type: 'context', ...context, label: 'Automatic context' });
      const instructions = selection
        ? 'This is a selection-only edit. First call read_selection. If the request includes behavior and prose, stage the behavior change first, then stage prose describing it. List explicit values and implicit short-circuit cases. Describe absence in prose so it cannot be mistaken for a literal string. Use short exact old anchors, reread the staged selection, and fix each omission before review_changes.'
        : [
          'Use supplied workspace excerpts first. Read narrowly for missing anchors. Put new definitions before code that needs them at module load and stage them with their registration. For before/after, copy the entire anchor line into old and match its indentation, or give a line number without old. Keep new tests collectable at module or test-class scope. Insert guide sections at a boundary between existing sections. Check each requested change before review_changes.',
          'Automatic context from the original instruction:',
          JSON.stringify(context)
        ].join('\n\n');

      const fallback = settings.fallbackModel && settings.fallbackModel !== settings.model ? settings.fallbackModel : null;
      const attempts = fallback ? [settings.model, fallback] : [settings.model, settings.model];
      for (let index = 0; index < attempts.length && !run.signal.aborted; index += 1) {
        const model = attempts[index];
        run.draft = new Draft({ loadDocument, selection, isActive: () => this.run === run && !run.signal.aborted });
        run.pending = null;
        run.reviewDecision = null;
        run.committed = false;
        run.rejected = false;
        run.staging = undefined;
        run.revisionDigest = undefined;
        run.revisionFeedback = undefined;
        if (index) {
          this.publish({ type: 'log', title: fallback ? 'Switching configured model' : 'Retrying after backoff', detail: model });
          await sleep(750, undefined, { signal: run.signal });
        }
        try {
          run.sessionId = await this.harness.createSession({
            model, instructions, mode: run.mode, eagerTools: settings.eagerTools,
            toolNames: selection ? INLINE_TOOLS : WORKSPACE_TOOLS,
            modelParams: { max_tokens: selection ? 800 : 2600, ...settings.modelParameters },
            config: { iteration_limit: selection ? 16 : 19 }
          });
          if (run.signal.aborted) {
            await this.harness.cancel(run.sessionId).catch(() => {});
            break;
          }
          this.publish({ type: 'session', id: run.sessionId, url: this.harness.sessionUrl(run.sessionId), model });
          this.publish({ type: 'status', text: 'TrueForge is working' });
          let outcome = await this.turn(run, instruction);
          let interruptions = 0;
          for (let resume = 0; resume < 7 && !run.committed && !run.pending && !run.signal.aborted; resume += 1) {
            const quotaDelay = rateLimitWait(outcome.state);
            const interrupted = quotaDelay === null && interruptions < 2 && run.draft.snapshot().files.length > 0 &&
              outcome.state?.status === 'error' && /\b503\b|headers timeout/i.test(terminalError(outcome.state));
            const delay = interrupted ? 1500 * (2 ** interruptions) : quotaDelay;
            if (delay === null) break;
            if (interrupted) interruptions += 1;
            this.publish({ type: 'log', title: interrupted ? 'Provider temporarily unavailable' : 'Provider rate limit',
              detail: `Resuming the same TrueForge session in ${(delay / 1000).toFixed(1)}s` });
            this.publish({ type: 'status', text: 'Waiting to reconnect to the provider' });
            await sleep(delay, undefined, { signal: run.signal });
            this.publish({ type: 'status', text: 'TrueForge is continuing the request' });
            outcome = await this.turn(run, 'Continue my original request after the provider interruption. Use the context and tool results already in this session. Keep any staged draft and avoid repeating earlier searches.');
          }
          const terminal = terminalError(outcome.state);
          const badArguments = /tool call validation failed/i.test(terminal);
          const iterationLimit = /iteration limit/i.test(terminal);
          const hasDraft = run.draft.snapshot().files.length > 0;
          const silent = outcome.state?.status === 'done' && outcome.state.output?.type === 'model.message' &&
            !outcome.state.output.content;
          const canContinue = badArguments || iterationLimit || silent || (hasDraft &&
            (outcome.state?.status === 'done' || /output truncated/i.test(terminal)));
          if (canContinue && !run.committed && !run.rejected && !run.pending && !run.signal.aborted) {
            this.publish({ type: 'log', title: 'Checking completion', detail: 'The draft has not reached review yet.' });
            const followup = run.revisionFeedback
              ? `Revise the current in-memory draft based on this rehearsal result: ${run.revisionFeedback} Preserve the parts that passed. Stage the correction with the editor tool before requesting review.`
              : badArguments
                ? `Continue my original request. The last tool call was rejected: ${terminal.slice(0, 350)}. Supply the required fields and proceed with the edit.`
                : 'Continue my original request. Reuse the context already supplied. Stage any remaining changes, check the resulting draft against each part of the request, then call review_changes.';
            outcome = await this.turn(run, followup);
          }
          if (run.signal.aborted || outcome.state?.status === 'cancelled') break;
          if (outcome.state?.status !== 'done') throw new Error(terminalError(outcome.state));
          this.publish({
            type: 'status',
            text: run.committed ? 'Review applied to editor' : run.rejected ? 'Draft rejected' : 'No approved edit was applied'
          });
          break;
        } catch (error) {
          if (run.signal.aborted) break;
          const retry = !run.committed && index + 1 < attempts.length && modelError(error) &&
            (fallback || !/400|401|402|403|unauthorized|invalid.api.key|quota/i.test(errorText(error)));
          if (!retry) throw error;
          this.publish({ type: 'log', title: `Model failed · ${model}`, detail: errorText(error) });
          this.publish({ type: 'draft', snapshot: { files: [] } });
        } finally {
          if (!run.committed) run.draft.cancel();
          if (run.sessionId) this.harness.releaseSession(run.sessionId);
          run.sessionId = null;
        }
      }
    } catch (error) {
      if (!run.signal.aborted) this.publish({ type: 'status', text: errorText(error), error: true });
    } finally {
      if (!run.committed) run.draft?.cancel();
      this.publish({ type: 'finish', applied: Boolean(run.committed) });
      if (this.run === run) this.run = null;
    }
  }

  async turn(run, instruction) {
    run.turnId = null;
    try {
      return await this.harness.streamTurn(run.sessionId, instruction, (event) => this.onEvent(run, event), { signal: run.signal });
    } catch (error) {
      if (run.signal.aborted || !run.turnId) throw error;
      const actual = await this.harness.getTurn(run.sessionId, run.turnId).catch(() => null);
      if (['done', 'error', 'cancelled'].includes(actual?.state?.status)) return actual;
      await this.harness.cancel(run.sessionId).catch(() => {});
      throw error;
    }
  }

  async onEvent(run, event) {
    if (this.run !== run || run.signal.aborted) return;
    if (event.type === 'turn.created') run.turnId = event.turn_id;
    if (event.type === 'model.message.delta' && typeof event.content === 'string' && event.content) {
      this.publish({ type: 'delta', content: event.content });
    }
    if (event.type === 'model.message' && event.tool_calls?.length) {
      this.publish({ type: 'log', title: 'Model selected tools', detail: event.tool_calls.map((call) => call.name ?? call.tool_name ?? call.function?.name).filter(Boolean).join(', ') });
    }
    if (event.type === 'tool.approval_required') {
      run.pending = {
        requests: (event.tool_calls ?? []).map((call) => ({ toolCallId: call.id, threadId: event.thread_id }))
      };
    }
    if (event.type === 'turn.update' && event.state?.status === 'paused' && run.pending && !run.pending.processing) {
      const pending = run.pending;
      pending.processing = true;
      const draft = run.draft.snapshot();
      if (changesKey(draft) === run.revisionDigest) {
        await this.harness.approve(run.sessionId, run.turnId, pending.requests.map((request) => ({
          ...request, status: 'deny', reason: `The draft is unchanged. Stage a correction for: ${run.revisionFeedback}`
        })));
        run.pending = null;
        return;
      }
      const files = await Promise.all(draft.files.map(({ path }) => run.draft.read(path)));
      const syntax = await pythonSyntax(run.root, run.settings, files, run.signal);
      if (run.signal.aborted) return;
      if (!draft.files.length || syntax.status === 'invalid') {
        this.publish({ type: 'log', title: 'Review declined', detail: syntax.diagnostic || 'There are no staged changes.' });
        const reason = syntax.status === 'invalid'
          ? `Correct this syntax error before requesting review again: ${syntax.path}:${syntax.diagnostic}`
          : 'Stage a concrete edit before requesting review.';
        await this.harness.approve(run.sessionId, run.turnId, pending.requests.map((request) => ({ ...request, status: 'deny', reason })));
        run.pending = null;
        return;
      }
      pending.snapshot = await run.draft.freeze();
      if (!pending.snapshot?.digest) pending.snapshot = run.draft.snapshot();
      this.publish({ type: 'review', snapshot: pending.snapshot, syntax });
      this.publish({ type: 'status', text: 'Waiting for your hunk decisions' });
      void this.review.show(run.draft, pending.snapshot.files[0].path).catch((error) => {
        this.publish({ type: 'log', title: 'Native diff', detail: errorText(error) });
      });
    }
  }

  async show(path, hunkIds) {
    if (!this.run?.draft) throw new Error('There is no live draft to preview.');
    return this.review.show(this.run.draft, path, hunkIds);
  }

  async decide({ digest, hunkIds }) {
    const run = this.run;
    const pending = run?.pending;
    if (!pending?.snapshot || pending.sending || pending.rehearsing || run.signal.aborted) throw new Error('Wait for the active review action to finish.');
    if (digest !== pending.snapshot.digest || !Array.isArray(hunkIds)) throw new Error('Review the current changes before applying.');
    const valid = new Set(pending.snapshot.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)));
    if (new Set(hunkIds).size !== hunkIds.length || hunkIds.some((id) => !valid.has(id))) throw new Error('The selected hunks do not match this draft.');
    pending.sending = true;
    try {
      const verified = pending.receipt;
      const sorted = [...hunkIds].sort();
      const matchesReceipt = verified && verified.hunkIds.length === sorted.length &&
        verified.hunkIds.every((id, index) => id === sorted[index]);
      if (matchesReceipt && run.settings.rehearsal?.executable) {
        const { rehearsalDigest } = require('./rehearse');
        const current = await rehearsalDigest({
          root: run.root, files: this.chosenFiles(run, sorted), check: run.settings.rehearsal,
          signal: run.signal, readBuffer: run.readBuffer
        });
        if (current !== verified.digest) {
          pending.receipt = null;
          this.publish({ type: 'rehearsal-error', detail: 'Workspace content changed. Verify these hunks again.' });
          throw new Error('Workspace content changed since rehearsal. Verify these hunks again.');
        }
      }
      if (hunkIds.length && hunkIds.length < valid.size) {
        const files = pending.snapshot.files.map(({ path }) => ({ path, text: run.draft.preview(path, hunkIds).after }));
        const syntax = await pythonSyntax(run.root, run.settings, files, run.signal);
        if (syntax.status === 'invalid') throw new Error(`Selected hunks do not parse in ${syntax.path}. ${syntax.diagnostic}`);
      }
      if (run.signal.aborted) return;
      run.reviewDecision = hunkIds.length ? {
        digest, hunkIds,
        verification: matchesReceipt ? {
          evidenceId: verified.evidenceId, check: run.settings.rehearsal?.executable ? 'configured check' : 'Python syntax',
          baseline: verified.baseline.status, candidate: verified.candidate.status,
        } : undefined
      } : null;
      await this.harness.approve(run.sessionId, run.turnId, pending.requests.map((request, index) => ({
        ...request, status: hunkIds.length && index === 0 ? 'allow' : 'deny'
      })));
      run.rejected = !hunkIds.length;
      run.pending = null;
      this.publish({ type: 'status', text: hunkIds.length ? 'Applying approved hunks' : 'Draft rejected' });
    } catch (error) {
      pending.sending = false;
      run.reviewDecision = null;
      throw error;
    }
  }

  async rehearse({ digest, hunkIds }) {
    const run = this.run;
    const pending = run?.pending;
    if (!pending?.snapshot || pending.sending || pending.rehearsing || run.signal.aborted) throw new Error('There is no idle approval to rehearse.');
    if (digest !== pending.snapshot.digest || !Array.isArray(hunkIds) || !hunkIds.length) throw new Error('Choose hunks from the current draft.');
    const valid = new Set(pending.snapshot.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)));
    if (new Set(hunkIds).size !== hunkIds.length || hunkIds.some((id) => !valid.has(id))) throw new Error('The selected hunks do not match this draft.');
    const selectedIds = [...hunkIds].sort();
    const files = this.chosenFiles(run, selectedIds);
    pending.rehearsing = true;
    this.publish({ type: 'rehearsal-start', draftDigest: digest, hunkIds: selectedIds });
    try {
      let receipt;
      if (run.settings.rehearsal?.executable) {
        const { rehearse } = require('./rehearse');
        receipt = await rehearse({
          root: run.root, files, check: run.settings.rehearsal, signal: run.signal,
          scratch: run.settings.scratch, readBuffer: run.readBuffer
        });
      } else {
        const standard = async (side) => {
          const start = Date.now();
          const syntax = await pythonSyntax(run.root, run.settings, files.map((file) => ({ path: file.path, text: file[side] })), run.signal);
          return {
            status: syntax.status === 'valid' ? 'passed' : syntax.status === 'invalid' ? 'failed' : 'unavailable',
            output: syntax.diagnostic || syntax.detail || (syntax.files ? `Parsed ${syntax.files} Python file(s).` : 'No Python edits in this selection.'),
            durationMs: Date.now() - start
          };
        };
        const [baseline, candidate] = await Promise.all([standard('before'), standard('after')]);
        receipt = {
          baseline, candidate, check: { label: 'Python syntax only' },
          digest: createHash('sha256').update(JSON.stringify({ digest, selectedIds, check: 'python syntax' })).digest('hex')
        };
      }
      const evidenceId = createHash('sha256').update(JSON.stringify({
        source: receipt.digest, hunkIds: selectedIds,
        baseline: [receipt.baseline.status, receipt.baseline.code, receipt.baseline.output],
        candidate: [receipt.candidate.status, receipt.candidate.code, receipt.candidate.output],
      })).digest('hex');
      const detail = { ...receipt, evidenceId, draftDigest: digest, hunkIds: selectedIds };
      pending.receipt = detail;
      if (!run.signal.aborted) this.publish({ type: 'rehearsal', ...detail });
      return detail;
    } catch (error) {
      if (!run.signal.aborted) this.publish({ type: 'rehearsal-error', detail: errorText(error) });
      throw error;
    } finally {
      pending.rehearsing = false;
    }
  }

  async requestRevision({ digest, feedback }) {
    const run = this.run;
    const pending = run?.pending;
    if (!pending?.snapshot || pending.snapshot.digest !== digest || pending.sending ||
        pending.rehearsing || run.signal.aborted) throw new Error('There is no idle review to revise.');
    if (typeof feedback !== 'string' || !feedback.trim()) throw new Error('Describe what needs to change.');
    const previous = { key: run.revisionDigest, feedback: run.revisionFeedback };
    pending.sending = true;
    run.pending = null;
    try {
      await run.draft.reopen(digest);
      run.revisionDigest = changesKey(pending.snapshot);
      run.revisionFeedback = feedback.trim().slice(0, 750);
      await this.harness.approve(run.sessionId, run.turnId, pending.requests.map((request) => ({
        ...request, status: 'deny',
        reason: `The original request remains in force. The rehearsal found: ${run.revisionFeedback} Keep working changes. Use ${run.selection ? 'stage_edit' : 'stage_edits'} to correct the issue before requesting review again.`
      })));
      this.publish({ type: 'log', title: 'Review sent back to TrueForge', detail: feedback.trim().slice(0, 750) });
      if (!run.pending) {
        this.publish({ type: 'draft', snapshot: run.draft.snapshot() });
        this.publish({ type: 'status', text: 'TrueForge is revising the draft' });
      }
    } catch (error) {
      if (!run.pending && !run.signal.aborted) {
        run.revisionDigest = previous.key;
        run.revisionFeedback = previous.feedback;
        pending.snapshot = await run.draft.freeze();
        pending.sending = false;
        run.pending = pending;
      }
      throw error;
    }
  }

  chosenFiles(run, selectedIds) {
    return run.pending.snapshot.files
      .filter((file) => file.hunks.some((hunk) => selectedIds.includes(hunk.id)))
      .map((file) => run.draft.preview(file.path, selectedIds));
  }

  async cancel() {
    const run = this.run;
    if (!run) return;
    run.abort.abort();
    run.draft?.cancel();
    this.publish({ type: 'status', text: run.committed ? 'Stopped after approval' : 'Cancelled. Draft discarded.' });
    if (run.sessionId) await this.harness.cancel(run.sessionId).catch(() => {});
  }

  async close() {
    await this.cancel();
    await this.harness?.close();
  }
}

module.exports = { Runner, modelError, terminalError, rateLimitWait, changesKey };
