// AgentBoard MCP stdio selftest: initialize -> tools/list -> list_workspaces ->
// create_task (with AGENTBOARD_AGENT_ID) -> list_tasks -> delete_task
// Negative: create_task without AGENTBOARD_AGENT_ID -> expect AGENT_ID_REQUIRED
import { spawn } from 'node:child_process';

const WS_ID = process.argv[2];
const SERVER = process.argv[3] || 'D:/WorkSpaces/任务看板/apps/mcp/dist/index.js';
const AGENT_ID = process.argv[4] || 'selftest-agent';

function session(env) {
  const child = spawn('node', [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.on('data', (c) => { process.env.MCP_DEBUG && process.stderr.write('[srv-err] ' + c); });
  const call = (method, params, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve });
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting ${method}`));
    }, timeoutMs);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const orig = pending.get(id).resolve;
    pending.set(id, { resolve: (msg) => { clearTimeout(timer); orig(msg); } });
  });
  const close = () => { try { child.kill(); } catch {} };
  return { call, close };
}

function brief(result) {
  const text = result?.content?.map((c) => c.text || '').join('\n') ?? '';
  return text.length > 400 ? text.slice(0, 400) + ` …(${text.length} chars)` : text;
}

const out = [];
const log = (step, detail) => { out.push({ step, detail }); console.log(`[${step}] ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

// --- Session A: with AGENT_ID (write allowed) ---
const a = session({ AGENTBOARD_AGENT_ID: AGENT_ID });

const init = await a.call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'selftest-mcp', version: '0.0.1' },
});
log('initialize', { protocolVersion: init.result?.protocolVersion, serverInfo: init.result?.serverInfo });

await a.call('notifications/initialized', {});

const tools = await a.call('tools/list', {});
const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
log('tools/list', { total: toolNames.length, withAgentboardPrefix: toolNames.filter((n) => n.startsWith('agentboard_')).length });
const ctSchema = (tools.result?.tools ?? []).find((t) => t.name === 'create_task');
log('create_task schema', JSON.stringify(ctSchema?.inputSchema ?? {}).slice(0, 600));

const lw = await a.call('tools/call', { name: 'list_workspaces', arguments: {} });
log('list_workspaces', brief(lw.result));

const REQ_ID = crypto.randomUUID();
const ct = await a.call('tools/call', {
  name: 'create_task',
  arguments: { workspace_id: WS_ID, title: 'selftest mcp issue', description: 'MCP stdio selftest', request_id: REQ_ID },
});
const createdText = brief(ct.result);
log('create_task', createdText);
const createdId = (createdText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
log('created issue id', createdId ?? 'NOT FOUND');

const lt = await a.call('tools/call', { name: 'list_tasks', arguments: { workspace_id: WS_ID } });
const ltText = lt.result?.content?.map((c) => c.text || '').join('\n') ?? '';
log('list_tasks', ltText.length > 700 ? ltText.slice(0, 700) + ` …(${ltText.length} chars)` : ltText);
const listedId = (ltText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
log('listed issue id', listedId ?? 'NOT FOUND');

const delId = createdId || listedId;
if (delId) {
  const dt = await a.call('tools/call', { name: 'delete_task', arguments: { task_id: delId } });
  log('delete_task', brief(dt.result));
} else {
  log('delete_task', 'SKIPPED: no created id');
}
a.close();

// --- Session B: WITHOUT AGENT_ID (write must fail with AGENT_ID_REQUIRED) ---
const b = session({ AGENTBOARD_AGENT_ID: undefined });
const init2 = await b.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest-mcp-neg', version: '0.0.1' } });
await b.call('notifications/initialized', {});
log('neg initialize', { protocolVersion: init2.result?.protocolVersion });

const neg = await b.call('tools/call', {
  name: 'create_task',
  arguments: { workspace_id: WS_ID, title: 'should fail no agent id', request_id: crypto.randomUUID() },
});
const isErr = neg.result?.isError === true;
log('neg create_task (no AGENT_ID) RAW', JSON.stringify(neg.result ?? neg).slice(0, 800));
log('neg isError', isErr);
const negText = neg.result?.content?.map((c) => c.text || '').join('\n') ?? '';
log('AGENT_ID_REQUIRED in text', String(negText).includes('AGENT_ID_REQUIRED'));
const negSc = JSON.stringify(neg.result?.structuredContent ?? {});
log('AGENT_ID_REQUIRED in structuredContent', negSc.includes('AGENT_ID_REQUIRED') + ' ' + negSc.slice(0, 300));
b.close();

console.log('SELFTEST-DONE');
