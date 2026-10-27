import { query, createSdkMcpServer, tool, USAGE_TRANSITION_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export function sessionOptions(cwd, abortController, callTool, env = process.env) {
  // Use the CLI's existing on-device login. Never export its OAuth credentials.
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDECODE$|AVIATOR_|SHARE_)/.test(key)) delete childEnv[key];
  }
  const definitions = [
    ['list', 'List a directory on the connected developer device.', { path: z.string().default('.') }],
    ['read', 'Read a text file on the connected developer device (64 KiB max).', { path: z.string() }],
    ['write', 'Write a text file on the developer device. Its owner approves locally.', { path: z.string(), content: z.string().max(65536) }],
    ['shell', 'Run a command on the developer device, after its owner approves locally. Timeout 120 seconds.', { path: z.string().default('.'), command: z.string().min(1).max(8000) }],
  ];
  const allowedTools = definitions.map(([name]) => `mcp__workspace__${name}`);
  return {
    cwd, env: childEnv, abortController, persistSession: false,
    settingSources: [], tools: [], allowedTools, maxTurns: 50,
    permissionMode: 'default',
    canUseTool: async (name, input) => allowedTools.includes(name)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'Only the connected workspace tools are available.' },
    systemPrompt: 'You are a remote coding assistant. ALL project files and commands are on the connected developer device. Use only workspace tools. The local host directory is not the project. Inspect the project before editing. Follow its instructions. Writes and commands require local approval. Never request credentials or try to bypass a denied tool. Explain changes and validation honestly.',
    mcpServers: { workspace: createSdkMcpServer({ name: 'workspace', version: '1.0.0', tools: definitions.map(([name, description, schema]) => tool(name, description, schema, async input => {
      try { return { content: [{ type: 'text', text: await callTool(name, input) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    })) }) },
  };
}

export async function runSession({ prompt, cwd, abortController, callTool, emit, queryImpl = query }) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  async function* input() {
    if (await gate) yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
  }
  const session = queryImpl({ prompt: input(), options: sessionOptions(cwd, abortController, callTool) });
  let timer;
  try {
    const account = await Promise.race([
      session.accountInfo(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Login check timed out.')), 30000); }),
    ]);
    clearTimeout(timer);
    if (!['pro', 'max'].includes(String(account.subscriptionType).toLowerCase()) || account.apiKeySource && account.apiKeySource !== 'none') {
      throw new Error('A saved Claude Pro or Max login is required; API authentication is disabled.');
    }
    if (abortController.signal.aborted) throw new Error('Cancelled.');
    release(true);
    for await (const message of session) {
      if (message.type === 'rate_limit_event' && (message.rate_limit_info?.status === 'rejected' || message.rate_limit_info?.isUsingOverage || message.rate_limit_info?.overageInUse || message.rate_limit_info?.rateLimitType === 'overage')) {
        abortController.abort();
        throw new Error('Subscription limit reached.');
      }
      if (message.type === 'system' && ['informational', 'notification'].includes(message.subtype)) {
        const notice = String(message.content || message.text || '');
        if (USAGE_TRANSITION_PREFIXES.some(prefix => /credits|extra usage/i.test(prefix) && notice.startsWith(prefix))) {
          abortController.abort();
          throw new Error('Paid extra usage is disabled for shared sessions.');
        }
      }
      if (message.type === 'assistant') for (const item of message.message.content) {
        if (item.type === 'text') emit({ type: 'text', text: item.text });
      }
      if (message.type === 'result') {
        if (message.is_error) throw new Error((message.errors || [message.subtype]).join('; '));
        emit({ type: 'result', text: message.result || 'Completed.' });
      }
    }
  } finally { clearTimeout(timer); release(false); session.close(); }
}
