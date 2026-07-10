// bd med-vcv.2 — the free-text drain agent's tool loop. The loop is a
// self-contained algorithm over two injected ports (chat, dispatcher), so it is
// pinned directly here; the drain/reply glue that wraps it lives in
// inbox-apply.test.js. Only the loop mechanics are under test: round-tripping
// tool calls, feeding tool errors back to the model, and the round budget.
import { describe, expect, it, vi } from 'vitest';
import { createTGAgent } from '../tg-agent.js';

// scriptedChat returns the responses in order, repeating the last one.
function scriptedChat(responses) {
  let i = 0;
  return vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);
}

describe('tg-agent.js — free-text tool loop', () => {
  it('runs a write op discovered via a tool call, then returns the final answer', async () => {
    const handle = vi.fn(async (method) => (method === 'mcp_help'
      ? { operations: ['health.notes.create'] }
      : { status: 'ok', result: { id: 1 } }));
    const chat = scriptedChat([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1',
          function: {
            name: 'mcp_call',
            arguments: JSON.stringify({ operation_id: 'health.notes.create', mode: 'write', intent: 'log note', params: { content: 'felt great' } }),
          },
        }],
      },
      { role: 'assistant', content: 'Logged your note.' },
    ]);

    const answer = await createTGAgent({ chat, dispatcher: { handle } }).run('note: felt great');

    expect(answer).toBe('Logged your note.');
    expect(handle).toHaveBeenCalledWith('mcp_call', expect.objectContaining({
      operation_id: 'health.notes.create', mode: 'write', intent: 'log note', params: { content: 'felt great' },
    }));
    expect(chat).toHaveBeenCalledTimes(2);
    // The second turn saw the tool result appended as a `tool` message.
    const secondTurn = chat.mock.calls[1][0].messages;
    expect(secondTurn.some((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true);
  });

  it('replies without calling any tool for plain chatter', async () => {
    const handle = vi.fn();
    const chat = scriptedChat([{ role: 'assistant', content: 'Hi! How can I help?' }]);
    expect(await createTGAgent({ chat, dispatcher: { handle } }).run('hello')).toBe('Hi! How can I help?');
    expect(handle).not.toHaveBeenCalled();
  });

  it('feeds a tool error back to the model instead of aborting the turn', async () => {
    const handle = vi.fn(async () => { throw new Error('unknown operation "bogus"'); });
    const chat = scriptedChat([
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'mcp_call', arguments: '{"operation_id":"bogus"}' } }] },
      { role: 'assistant', content: 'Sorry, I could not do that.' },
    ]);
    expect(await createTGAgent({ chat, dispatcher: { handle } }).run('do a bogus thing')).toBe('Sorry, I could not do that.');
    const toolMsg = chat.mock.calls[1][0].messages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toContain('unknown operation');
  });

  it('forces a final plain answer when the round budget runs out mid-tool-use', async () => {
    const handle = vi.fn(async () => ({ status: 'ok', result: {} }));
    // With tools it always asks for another call; without tools (the forced
    // final turn) it answers.
    const chat = vi.fn(async ({ tools }) => (tools
      ? { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'mcp_help', arguments: '{}' } }] }
      : { role: 'assistant', content: 'Here is what I did.' }));

    expect(await createTGAgent({ chat, dispatcher: { handle }, maxRounds: 2 }).run('loop')).toBe('Here is what I did.');
    // 2 budgeted tool rounds + 1 forced no-tools final.
    expect(chat).toHaveBeenCalledTimes(3);
  });
});
