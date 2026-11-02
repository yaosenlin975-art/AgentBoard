/**
 * IMG-04 隔离 fixture 的 API 级验收脚本（真实 HTTP，端口 18789）。
 *
 * 前置：node apps/server/test/fixtures/img04FixtureServer.mjs 已启动（写出 <root>/fixture.json）。
 * 运行：node apps/server/test/fixtures/img04FixtureChecks.mjs
 *
 * 覆盖：
 *  A pending-attachments 返回全部 pending/unknown（不被分页/状态截断）
 *  B 图片下载 200 + image/png + PNG 魔数
 *  C 超过 5 张 / 超过 20 MiB 时只发有界前缀，prompt 含「另有 N 张未附」，响应含 remaining_attachment_count
 *  D 只标记本批已交付的 selected IDs，未选图保持待读
 *  E 失败路径：unknown、待读游标不推进、不自动重发；retry_unknown_images 显式确认后才重发；幂等重放不重复创建评论
 *  F DB quick_check
 *
 * 结果写入 <root>/evidence.json，并在 stdout 打印 JSON 行证据。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { makeLargeMarkerPng, makeMarkerPng, PNG_SIGNATURE } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.IMGFIX_ROOT ?? join(here, '..', '.fixture-img04'));
const info = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
const base = info.base_url;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const evidence = [];
function check(name, actual, expected, ok = JSON.stringify(actual) === JSON.stringify(expected)) {
  evidence.push({ name, actual, expected, ok });
  console.log(JSON.stringify({ type: 'check', name, actual, expected, ok }));
  return ok;
}
function note(name, detail) {
  evidence.push({ name, detail });
  console.log(JSON.stringify({ type: 'note', name, detail }));
}

async function req(method, path, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(base + path, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if (!raw) {
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, json, buffer: raw ? buf : null, text: raw ? null : buf.toString('utf8') };
}

function calls() {
  if (!existsSync(info.callsPath)) return [];
  return readFileSync(info.callsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const pending = async (issueId) => (await req('GET', `/api/issues/${issueId}/pending-attachments`)).json;

async function main() {
  // ---- 准备工作区 / 任务（脚本可重复执行：工作区按 path 复用） ----
  const workspaces = (await req('GET', '/api/workspaces')).json;
  const existingWs = workspaces.find((w) => w.path === info.workspaceDir);
  const ws = existingWs ?? (await req('POST', '/api/workspaces', {
    body: JSON.stringify({ name: 'IMG04 合成工作区', path: info.workspaceDir }),
    headers: { 'Content-Type': 'application/json' },
  })).json;
  check('workspace.created', typeof ws.id === 'string' && ws.path === info.workspaceDir, true);
  const callsBaseline = calls().length;
  const callsSince = () => calls().slice(callsBaseline);

  const mkIssue = async (title) => (await req('POST', '/api/issues', {
    body: JSON.stringify({ workspace_id: ws.id, title, description: 'IMG-04 隔离 fixture 合成任务' }),
    headers: { 'Content-Type': 'application/json' },
  })).json;

  const uploadPng = async (buf, name) => (await req('POST', `/api/workspaces/${ws.id}/attachments`, {
    body: buf,
    headers: { 'Content-Type': 'image/png', 'X-File-Name': name },
  })).json;

  const addComment = async (issueId, content, attachmentIds, headers = {}) => {
    const res = await req('POST', `/api/issues/${issueId}/comments`, {
      body: JSON.stringify({ content, attachment_ids: attachmentIds, agent_id: 'mcode', workspace_id: ws.id }),
      headers: { 'Content-Type': 'application/json', ...headers },
    });
    if (res.status !== 200) {
      throw new Error(`addComment 失败 status=${res.status} body=${res.text}`);
    }
    return res;
  };

  // ================= 场景 A：7 张小图（触发 5 张上限） =================
  const issueA = await mkIssue('IMG04-A 数量上限');
  const smallPngs = [];
  for (let i = 0; i < 7; i += 1) smallPngs.push(makeMarkerPng(i + 1));
  const stagedA = [];
  for (let i = 0; i < smallPngs.length; i += 1) {
    stagedA.push(await uploadPng(smallPngs[i], `marker-${i + 1}.png`));
  }
  note('A.staged.sizes', stagedA.map((s) => s.size_bytes));

  // A1：pending-attachments 返回全部 7 张（不分页截断）
  // 注意：附件只有在绑定到评论后才属于 issue，故先建评论再查 pending
  await addComment(issueA.id, 'IMG04-A 第一批图片（5 张）', stagedA.slice(0, 5).map((s) => s.id));
  await addComment(issueA.id, 'IMG04-A 第二批图片（2 张）', stagedA.slice(5).map((s) => s.id));
  const pendingA0 = await pending(issueA.id);
  check('A1.pending_count', pendingA0.items.length, 7);
  check('A1.next_offset', pendingA0.next_offset, null);
  check('A1.all_pending', pendingA0.items.every((i) => i.delivery_state === 'pending'), true);
  check('A1.snippet_len_le_500', pendingA0.items.every((i) => i.snippet.length <= 500), true);

  // A2：图片下载 200 + image/png + PNG 魔数
  const dl = await req('GET', `/api/issues/${issueA.id}/attachments/${pendingA0.items[0].id}`, { raw: true });
  check('A2.download_status', dl.status, 200);
  check('A2.content_type', dl.headers.get('content-type'), 'image/png');
  check('A2.png_magic', dl.buffer.subarray(0, 8).equals(PNG_SIGNATURE), true);
  const dl2 = await req('GET', `/api/issues/${issueA.id}/attachments/${pendingA0.items[1].id}`, { raw: true });
  check('A2.second_download_status', dl2.status, 200);
  check('A2.second_png_magic', dl2.buffer.subarray(0, 8).equals(PNG_SIGNATURE), true);

  // A3：两条评论（每条 ≤5 张），顺序按评论时间/评论ID/附件位置
  const pendingA1 = await pending(issueA.id);
  check('A3.pending_after_comments', pendingA1.items.length, 7);

  // A4：提交 7 个 selected IDs → 只发有界前缀 5 张
  const allIdsA = pendingA1.items.map((i) => i.id);
  const dispatchA = await req('POST', '/api/sessions', {
    body: JSON.stringify({
      issue_id: issueA.id,
      cli: 'codebuddy',
      model: 'minimax-m3.1-flash',
      selected_attachment_ids: allIdsA,
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('A4.dispatch_status', dispatchA.status, 200);
  check('A4.remaining_attachment_count', dispatchA.json.remaining_attachment_count, 2);
  const sessionA = dispatchA.json.id ?? dispatchA.json.session?.id;
  await sleep(400);
  const callsA = callsSince();
  const callA1 = callsA[callsA.length - 1];
  check('A4.adapter_call_count', callsA.length, 1);
  check('A4.attachment_count_le_5', callA1.attachment_count, 5);
  check('A4.attachment_total_bytes_le_20MiB', callA1.attachment_total_bytes <= 20 * 1024 * 1024, true);
  check('A4.prompt_has_remaining_notice', /另有\s*2\s*张未附/.test(callA1.prompt), true);
  check('A4.prompt_mentions_images', callA1.prompt.includes('## 本批随附图片评论引用'), true);
  note('A4.prompt_tail', callA1.prompt.slice(-260));

  // A5：只标记本批已交付的 selected IDs，未选图仍为待读
  const pendingA2 = await pending(issueA.id);
  check('A5.remaining_pending_count', pendingA2.items.length, 2);
  check('A5.remaining_are_original_tail', pendingA2.items.map((i) => i.id).sort().join(',') === allIdsA.slice(5).sort().join(','), true);
  const deliveredIds = callsA[0].attachments.map((a) => a.path);
  check('A5.delivered_paths_count', deliveredIds.length, 5);

  // A6：同一绑定会话续批（reuse_session=last）→ 不新建会话、不重复投递已交付图片
  const dispatchA2 = await req('POST', '/api/sessions', {
    body: JSON.stringify({
      issue_id: issueA.id,
      cli: 'codebuddy',
      model: 'minimax-m3.1-flash',
      reuse_session: 'last',
      selected_attachment_ids: pendingA2.items.map((i) => i.id),
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('A6.dispatch_status', dispatchA2.status, 200);
  check('A6.same_session_id', dispatchA2.json.id ?? dispatchA2.json.session?.id, sessionA);
  await sleep(400);
  const callsA2 = callsSince();
  check('A6.adapter_call_count', callsA2.length, 2);
  const callA2 = callsA2[1];
  check('A6.second_batch_attachment_count', callA2.attachment_count, 2);
  check('A6.no_duplicate_paths', callA2.attachments.every((a) => !callsA2[0].attachments.some((b) => b.path === a.path)), true);
  check('A6.prompt_no_remaining_notice', /另有\s*\d+\s*张未附/.test(callA2.prompt), false);
  const pendingA3 = await pending(issueA.id);
  check('A6.pending_empty_after_continuation', pendingA3.items.length, 0);

  // ================= 场景 B：5 张大图（触发 20 MiB 上限） =================
  const issueB = await mkIssue('IMG04-B 体积上限');
  const largePng = makeLargeMarkerPng(9);
  const stagedB = [];
  for (let i = 0; i < 5; i += 1) stagedB.push(await uploadPng(largePng, `large-${i + 1}.png`));
  note('B.staged.sizes', stagedB.map((s) => s.size_bytes));
  await addComment(issueB.id, 'IMG04-B 五张 4MiB+ 大图', stagedB.map((s) => s.id));
  const pendingB0 = await pending(issueB.id);
  check('B.pending_count', pendingB0.items.length, 5);
  const dispatchB = await req('POST', '/api/sessions', {
    body: JSON.stringify({
      issue_id: issueB.id,
      cli: 'codebuddy',
      model: 'minimax-m3.1-flash',
      selected_attachment_ids: pendingB0.items.map((i) => i.id),
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('B.dispatch_status', dispatchB.status, 200);
  check('B.remaining_attachment_count', dispatchB.json.remaining_attachment_count, 1);
  await sleep(600);
  const callB = callsSince()[callsSince().length - 1];
  check('B.attachment_count_lt_5', callB.attachment_count, 4);
  check('B.attachment_total_bytes_le_20MiB', callB.attachment_total_bytes <= 20 * 1024 * 1024, true);
  check('B.prompt_has_remaining_notice', /另有\s*1\s*张未附/.test(callB.prompt), true);
  note('B.batch_bytes', { total: callB.attachment_total_bytes, limit: 20 * 1024 * 1024, count: callB.attachment_count });
  const pendingB1 = await pending(issueB.id);
  check('B.remaining_pending', pendingB1.items.length, 1);

  // ================= 场景 C：失败 → unknown → 显式确认才重发 =================
  const issueC = await mkIssue('IMG04-C 失败与显式重试');
  const stagedC = [await uploadPng(makeMarkerPng(4), 'marker-4.png')];
  await addComment(issueC.id, 'IMG04-C 单张图片', stagedC.map((s) => s.id));
  const pendingC0 = await pending(issueC.id);
  check('C.pending_count', pendingC0.items.length, 1);
  const callsBeforeC = callsSince().length;

  writeFileSync(info.root + '/fail-next', 'force-fail', 'utf8');
  const dispatchC = await req('POST', '/api/sessions', {
    body: JSON.stringify({
      issue_id: issueC.id,
      cli: 'codebuddy',
      model: 'minimax-m3.1-flash',
      selected_attachment_ids: pendingC0.items.map((i) => i.id),
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('C.dispatch_status', dispatchC.status, 200);
  await sleep(500);
  check('C.adapter_call_count_after_failure', callsSince().length - callsBeforeC, 1);
  const pendingC1 = await pending(issueC.id);
  check('C.state_unknown', pendingC1.items[0]?.delivery_state, 'unknown');
  check('C.still_pending_listed', pendingC1.items.length, 1);

  // 待读游标不推进：consume 停在带未交付图片的评论之前
  const consumeC = await req('POST', `/api/issues/${issueC.id}/comments/consume`);
  check('C.consume_status', consumeC.status, 200);
  check('C.consume_new_comment_ids_excludes_image_comment', consumeC.json.new_comment_ids.includes(pendingC0.items[0].comment_id), false);
  const consumeC2 = await req('POST', `/api/issues/${issueC.id}/comments/consume`);
  check('C.consume_repeat_same', consumeC2.json.new_comment_ids.length, 0);

  // 未显式确认不得重发
  const callsBeforeRetry = callsSince().length;
  const dispatchC2 = await req('POST', '/api/sessions', {
    body: JSON.stringify({
      issue_id: issueC.id,
      cli: 'codebuddy',
      model: 'minimax-m3.1-flash',
      reuse_session: 'last',
      selected_attachment_ids: pendingC1.items.map((i) => i.id),
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('C.retry_without_confirm_status', dispatchC2.status, 400);
  check('C.retry_without_confirm_code', String(dispatchC2.json?.error?.message ?? '').split(':')[0], 'IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED');
  check('C.no_auto_resend', callsSince().length - callsBeforeRetry, 0);

  // 显式确认后重发
  const dispatchC3 = await req('POST', '/api/sessions', {
    body: JSON.stringify({
      issue_id: issueC.id,
      cli: 'codebuddy',
      model: 'minimax-m3.1-flash',
      reuse_session: 'last',
      retry_unknown_images: true,
      selected_attachment_ids: pendingC1.items.map((i) => i.id),
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('C.retry_with_confirm_status', dispatchC3.status, 200);
  await sleep(500);
  check('C.retry_adapter_call_count', callsSince().length - callsBeforeRetry, 1);
  const pendingC3 = await pending(issueC.id);
  check('C.pending_empty_after_delivered', pendingC3.items.length, 0);

  // ================= 场景 D：幂等重放不重复创建评论 / 会话 =================
  const issueD = await mkIssue('IMG04-D 幂等重放');
  const stagedD = [await uploadPng(makeMarkerPng(7), 'marker-7.png')];
  const key = randomUUID(); // 每次运行用新 UUID：同一请求 ID 不可复用于不同操作
  const commentD1 = await addComment(issueD.id, 'IMG04-D 幂等评论', stagedD.map((s) => s.id), { 'Idempotency-Key': key });
  const commentD2 = await addComment(issueD.id, 'IMG04-D 幂等评论', stagedD.map((s) => s.id), { 'Idempotency-Key': key });
  check('D.comment_first_status', commentD1.status, 200);
  check('D.comment_replay_same_id', commentD2.json?.comment?.id, commentD1.json?.comment?.id);
  const commentsD = (await req('GET', `/api/issues/${issueD.id}/comments`)).json;
  check('D.comment_count', commentsD.length, 1);

  const dispatchKey = randomUUID();
  const bodyD = JSON.stringify({
    issue_id: issueD.id,
    cli: 'codebuddy',
    model: 'minimax-m3.1-flash',
    selected_attachment_ids: (await pending(issueD.id)).items.map((i) => i.id),
  });
  const sessionD1 = await req('POST', '/api/sessions', { body: bodyD, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': dispatchKey } });
  await sleep(400);
  const sessionD2 = await req('POST', '/api/sessions', { body: bodyD, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': dispatchKey } });
  await sleep(400);
  note('D.dispatch_new_session_responses', {
    first: { status: sessionD1.status, id: sessionD1.json?.id },
    second: { status: sessionD2.status, error: sessionD2.json?.error?.code },
  });
  // 新建会话分支：同 key 重放不得产生第二个会话/第二条评论（占用冲突即拒绝，不重复创建）
  const sessionsD = (await req('GET', `/api/sessions?workspace=${ws.id}`)).json;
  check('D.session_count_for_issue', sessionsD.filter((s) => s.issue_id === issueD.id).length, 1);
  check('D.comment_count_after_dispatch', (await req('GET', `/api/issues/${issueD.id}/comments`)).json.length, 1);

  // D2：复用已绑定会话分支（issue A 已交付完图片）——同 key 重放应回放同一结果且不重复起轮
  const reuseKey = randomUUID();
  const reuseBody = JSON.stringify({
    issue_id: issueA.id,
    cli: 'codebuddy',
    model: 'minimax-m3.1-flash',
    reuse_session: 'last',
  });
  const callsBeforeReuse = callsSince().length;
  const reuse1 = await req('POST', '/api/sessions', { body: reuseBody, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': reuseKey } });
  await sleep(400);
  const reuse2 = await req('POST', '/api/sessions', { body: reuseBody, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': reuseKey } });
  await sleep(400);
  check('D2.reuse_first_status', reuse1.status, 200);
  check('D2.reuse_replay_status', reuse2.status, 200);
  check('D2.reuse_replay_same_session', reuse2.json?.id ?? reuse2.json?.session?.id, reuse1.json?.id ?? reuse1.json?.session?.id);
  check('D2.reuse_replay_no_extra_turn', callsSince().length - callsBeforeReuse, 1);
  note('D2.reuse_responses', { first_id: reuse1.json?.id, second_id: reuse2.json?.id ?? reuse2.json?.session?.id, second_error: reuse2.json?.error?.code });

  // ================= 场景 F：WS 实时投递事件（浏览器端「结果未知」提示与待读刷新依赖） =================
  const socket = new WebSocket(`${info.base_url.replace(/^http/, 'ws')}/ws`);
  const frames = [];
  socket.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      // 非 JSON 帧忽略
    }
  });
  const socketState = await new Promise((resolve) => {
    socket.on('open', () => resolve('open'));
    socket.on('error', () => resolve('error'));
  });
  check('F.ws_open', socketState, 'open');

  const issueF = await mkIssue('IMG04-F WS 投递事件');
  const stagedF = [await uploadPng(makeMarkerPng(9), 'ws-event.png')];
  const commentF = await addComment(issueF.id, 'WS 事件探针', stagedF.map((s) => s.id));
  const commentIdF = commentF.json?.comment?.id ?? null;
  writeFileSync(info.root + '/fail-next', 'force-fail', 'utf8');
  const dispatchF = await req('POST', '/api/sessions', {
    body: JSON.stringify({
      issue_id: issueF.id,
      cli: 'codebuddy',
      model: 'minimax-m3.1-flash',
      selected_attachment_ids: stagedF.map((s) => s.id),
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('F.dispatch_status', dispatchF.status, 200);
  for (let i = 0; i < 60 && !frames.some((f) => f.type === 'comment.delivery.changed'); i += 1) await sleep(100);
  const deliveryFrames = frames.filter((f) => f.type === 'comment.delivery.changed');
  check('F.ws_delivery_event_seen', deliveryFrames.length > 0, true);
  check('F.ws_delivery_event_issue', deliveryFrames.at(-1)?.issue_id ?? null, issueF.id);
  check('F.ws_delivery_event_comment', (deliveryFrames.at(-1)?.comment_ids ?? []).includes(commentIdF), true);
  note('F.ws_frame_types', frames.map((f) => f.type).slice(0, 12));
  socket.close();

  // ================= 场景 E：DB quick_check =================
  const db = new Database(info.dbPath, { readonly: true });
  const quick = db.pragma('quick_check');
  db.close();
  check('E.db_quick_check', quick.map((row) => row.quick_check ?? Object.values(row)[0]), ['ok']);

  const failed = evidence.filter((e) => e.ok === false);
  const summary = {
    generated_at: new Date().toISOString(),
    base_url: base,
    fixture: info,
    total_checks: evidence.filter((e) => e.ok !== undefined).length,
    failed_checks: failed.length,
    evidence,
  };
  writeFileSync(join(root, 'evidence.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ type: 'summary', total_checks: summary.total_checks, failed_checks: failed.length }));
  if (failed.length > 0) process.exitCode = 1;
}

await main();
