require('dotenv').config();
const { App, LogLevel } = require('@slack/bolt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();
const CLAUDE_EXTRA_ARGS = (process.env.CLAUDE_EXTRA_ARGS || '')
  .split(' ')
  .map((s) => s.trim())
  .filter(Boolean);
const SLACK_USER_WHITELIST = new Set(
  (process.env.SLACK_USER_WHITELIST || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
);

function parseCwdMap(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`CLAUDE_CWD_MAP parse failed: ${e.message} — ignoring`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error('CLAUDE_CWD_MAP must be a JSON array — ignoring');
    return [];
  }
  const out = [];
  for (const entry of parsed) {
    if (entry && typeof entry.phrase === 'string' && entry.phrase && typeof entry.cwd === 'string' && entry.cwd) {
      out.push({ phrase: entry.phrase, cwd: entry.cwd });
    } else {
      console.error(`CLAUDE_CWD_MAP: skipping invalid entry ${JSON.stringify(entry)}`);
    }
  }
  return out;
}
const CLAUDE_CWD_MAP = parseCwdMap(process.env.CLAUDE_CWD_MAP);

function resolveCwd(text) {
  if (!text || CLAUDE_CWD_MAP.length === 0) return CLAUDE_CWD;
  for (const entry of CLAUDE_CWD_MAP) {
    if (text.includes(entry.phrase)) return entry.cwd;
  }
  return CLAUDE_CWD;
}

const LOG_FILE = path.resolve(CLAUDE_CWD, 'messages.log');
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

function logEvent(kind, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n';
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error('log write failed:', err.message);
  });
}

const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')} — copy .env.example to .env`);
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// threadKey -> claude session_id
const sessions = new Map();
// threadKey -> スレッド初回に決まった cwd（以降そのスレッドでは固定）
const threadCwds = new Map();
// auth.test で起動時に埋める
let botUserId = null;

const THREAD_HISTORY_LIMIT = 100;
const THREAD_MESSAGE_CHAR_LIMIT = 2000;

function threadKey(event) {
  const thread = event.thread_ts || event.ts;
  return `${event.channel}:${thread}`;
}

async function fetchThreadHistory(client, channel, thread_ts, currentTs) {
  try {
    const res = await client.conversations.replies({
      channel,
      ts: thread_ts,
      limit: THREAD_HISTORY_LIMIT,
    });
    const messages = Array.isArray(res.messages) ? res.messages : [];
    return messages.filter((m) => m.ts !== currentTs);
  } catch (e) {
    console.error('conversations.replies failed:', e.message);
    return [];
  }
}

function formatThreadHistory(messages) {
  if (!messages || messages.length === 0) return '';
  const lines = [
    '<thread_context>',
    'このスレッドには既に以下のやり取りがあります。文脈として参照してください（あなた自身の過去の発言は [assistant]、他ユーザーの発言は [user:<id>]）。',
    '',
  ];
  let added = 0;
  for (const m of messages) {
    const raw = (m.text || '').replace(/<@[^>]+>\s*/g, '').trim();
    if (!raw) continue;
    const text = raw.length > THREAD_MESSAGE_CHAR_LIMIT
      ? raw.slice(0, THREAD_MESSAGE_CHAR_LIMIT) + '…(省略)'
      : raw;
    const isAssistant = (botUserId && m.user === botUserId) || Boolean(m.bot_id);
    const who = isAssistant ? 'assistant' : `user:${m.user || 'unknown'}`;
    lines.push(`[${who}]: ${text}`);
    added++;
  }
  if (added === 0) return '';
  lines.push('</thread_context>', '');
  return lines.join('\n');
}

function isSlackUserAllowed(userId) {
  if (!userId) return false;
  if (SLACK_USER_WHITELIST.size === 0) return true;
  return SLACK_USER_WHITELIST.has(userId);
}

async function rejectDisallowedUser(client, event) {
  const thread_ts = event.thread_ts || event.ts;
  const text = ':no_entry: この bot は許可されたユーザーのみ利用できます。';

  logEvent('user_blocked', {
    channel: event.channel,
    thread_ts,
    user: event.user,
  });

  try {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text,
    });
  } catch (e) {
    console.error('postMessage(blocked) failed:', e.message);
  }
}

function safeName(name) {
  return (name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

async function downloadSlackFile(file, destDir) {
  const url = file.url_private_download || file.url_private;
  if (!url) throw new Error(`no download url for file ${file.id}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const fname = `${file.id}-${safeName(file.name)}`;
  const fpath = path.join(destDir, fname);
  await fs.promises.writeFile(fpath, buf);
  return fpath;
}

async function downloadFiles(files, threadTs, uploadDir) {
  const destDir = path.join(uploadDir, threadTs);
  await fs.promises.mkdir(destDir, { recursive: true });
  const results = [];
  for (const f of files) {
    try {
      const fpath = await downloadSlackFile(f, destDir);
      results.push({ ok: true, path: fpath, name: f.name, mimetype: f.mimetype });
    } catch (e) {
      results.push({ ok: false, name: f.name, error: e.message });
    }
  }
  return results;
}

function buildSystemPrompt(outputDir) {
  return [
    'あなたは Slack bot 経由で呼び出されています。ユーザーとの対話は通常通り行ってください。',
    'ユーザーに成果物をファイルで返したい場合（CSV / 画像 / コード等）に限り、下記 OUTPUT_DIR にファイルを書き出してください。そのディレクトリに書かれたファイルは自動で Slack にアップロードされます。',
    'OUTPUT_DIR はシステムから提供されているので、ユーザーに出力先パスを尋ねてはいけません。OUTPUT_DIR の存在についてユーザーに言及する必要もありません。',
    '通常の会話・質問にはそのまま答えてください。ファイル出力が不要な場合は OUTPUT_DIR に何も書かなくて構いません。',
    '',
    `OUTPUT_DIR: ${outputDir}`,
  ].join('\n');
}

function buildUserPrompt(userText, downloaded, threadContext) {
  const lines = [];
  if (threadContext) {
    lines.push(threadContext);
  }
  if (downloaded && downloaded.length > 0) {
    lines.push('<attachments>');
    for (const d of downloaded) {
      if (d.ok) {
        lines.push(`- ${d.path}  (${d.name}${d.mimetype ? `, ${d.mimetype}` : ''})`);
      } else {
        lines.push(`- [DOWNLOAD FAILED] ${d.name}: ${d.error}`);
      }
    }
    lines.push('</attachments>', '');
  }
  lines.push(userText || '(本文なし)');
  return lines.join('\n');
}

async function collectNewFiles(dir, sinceMs) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const stat = await fs.promises.stat(full);
          if (stat.mtimeMs >= sinceMs) {
            out.push({ path: full, size: stat.size });
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(dir);
  return out;
}

async function uploadOutputsToSlack(client, channel, thread_ts, files) {
  const results = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) {
      results.push({ ok: false, path: f.path, error: `skipped (${f.size} bytes > 100MB)` });
      continue;
    }
    try {
      await client.files.uploadV2({
        channel_id: channel,
        thread_ts,
        file: fs.createReadStream(f.path),
        filename: path.basename(f.path),
      });
      results.push({ ok: true, path: f.path });
    } catch (e) {
      results.push({ ok: false, path: f.path, error: e.message });
    }
  }
  return results;
}

function runClaude(prompt, sessionId, systemPrompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--setting-sources', 'user,project,local', ...CLAUDE_EXTRA_ARGS];
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (sessionId) args.push('--resume', sessionId);

    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr || stdout}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          text: parsed.result ?? parsed.response ?? stdout,
          sessionId: parsed.session_id ?? null,
        });
      } catch {
        resolve({ text: stdout.trim(), sessionId: null });
      }
    });

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

async function handleUserMessage({ event, say, client }) {
  if (!isSlackUserAllowed(event.user)) {
    await rejectDisallowedUser(client, event);
    return;
  }

  const rawText = (event.text || '').replace(/<@[^>]+>\s*/g, '').trim();
  const files = Array.isArray(event.files) ? event.files : [];
  if (!rawText && files.length === 0) return;

  const key = threadKey(event);
  const thread_ts = event.thread_ts || event.ts;
  let cwd = threadCwds.get(key);
  if (!cwd) {
    cwd = resolveCwd(rawText);
    threadCwds.set(key, cwd);
  }
  const uploadDir = path.resolve(cwd, 'slack-uploads');
  const outputBaseDir = path.resolve(cwd, 'slack-outputs');

  let thinking;
  try {
    const msg =
      files.length > 0
        ? `_ファイル${files.length}件を受信、処理中..._ :hourglass_flowing_sand:`
        : '_考え中..._ :hourglass_flowing_sand:';
    thinking = await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: msg,
    });
  } catch (e) {
    console.error('postMessage(thinking) failed:', e.message);
  }

  logEvent('user_message', {
    channel: event.channel,
    thread_ts,
    user: event.user,
    text: rawText,
    attachments: files.map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size })),
  });

  try {
    let downloaded = [];
    if (files.length > 0) {
      downloaded = await downloadFiles(files, thread_ts, uploadDir);
      logEvent('files_downloaded', {
        thread_ts,
        files: downloaded.map((d) => ({ ok: d.ok, name: d.name, path: d.path, error: d.error })),
      });
    }

    const outputDir = path.join(outputBaseDir, thread_ts);
    await fs.promises.mkdir(outputDir, { recursive: true });

    const prior = sessions.get(key);

    // スレッドの途中で初めて呼ばれた場合は、過去のやり取りをプロンプトに注入する。
    // session を既に持っている場合は --resume で継続するので再取得は不要。
    let threadContext = '';
    const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
    if (!prior && isThreadReply) {
      const history = await fetchThreadHistory(client, event.channel, event.thread_ts, event.ts);
      threadContext = formatThreadHistory(history);
      logEvent('thread_history_loaded', {
        channel: event.channel,
        thread_ts,
        message_count: history.length,
        included: threadContext ? true : false,
      });
    }

    const systemPrompt = buildSystemPrompt(outputDir.replace(/\\/g, '/'));
    const userPrompt = buildUserPrompt(rawText, downloaded, threadContext);
    const runStartedAt = Date.now();
    const { text: reply, sessionId } = await runClaude(userPrompt, prior, systemPrompt, cwd);
    if (sessionId) sessions.set(key, sessionId);

    const body = reply && reply.length > 0 ? reply : '(応答が空でした)';
    const broadcast = /send reply to this channel/i.test(rawText);
    logEvent('claude_response', {
      channel: event.channel,
      thread_ts,
      session_id: sessionId,
      duration_ms: Date.now() - runStartedAt,
      broadcast,
      cwd,
      text: body,
    });

    if (broadcast) {
      // chat.update does not support reply_broadcast — delete the placeholder and post fresh.
      if (thinking?.ts) {
        try {
          await client.chat.delete({ channel: event.channel, ts: thinking.ts });
        } catch (e) {
          console.error('chat.delete(thinking) failed:', e.message);
        }
      }
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts,
        text: body,
        reply_broadcast: true,
      });
    } else if (thinking?.ts) {
      await client.chat.update({
        channel: event.channel,
        ts: thinking.ts,
        text: body,
      });
    } else {
      await say({ text: body, thread_ts });
    }

    const newFiles = await collectNewFiles(outputDir, runStartedAt);
    if (newFiles.length > 0) {
      const results = await uploadOutputsToSlack(client, event.channel, thread_ts, newFiles);
      logEvent('files_uploaded', {
        thread_ts,
        files: results.map((r) => ({ ok: r.ok, path: r.path, error: r.error })),
      });
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts,
          text:
            `:warning: 一部ファイルのアップロードに失敗\n` +
            failed.map((f) => `- ${path.basename(f.path)}: ${f.error}`).join('\n'),
        });
      }
    }
  } catch (err) {
    console.error('claude failed:', err);
    logEvent('error', { channel: event.channel, thread_ts, message: err.message });
    const errText = `:warning: 処理失敗\n\`\`\`${err.message}\`\`\``;
    if (thinking?.ts) {
      await client.chat.update({ channel: event.channel, ts: thinking.ts, text: errText });
    } else {
      await say({ text: errText, thread_ts });
    }
  }
}

app.event('app_mention', handleUserMessage);

app.message(async (args) => {
  const { event } = args;
  if (event.channel_type !== 'im') return;
  if (event.subtype && event.subtype !== 'file_share') return;
  if (event.bot_id) return;
  await handleUserMessage(args);
});

(async () => {
  await app.start();
  try {
    const auth = await app.client.auth.test({ token: process.env.SLACK_BOT_TOKEN });
    botUserId = auth.user_id || null;
  } catch (e) {
    console.error('auth.test failed:', e.message);
  }
  logEvent('startup', {
    cwd: CLAUDE_CWD,
    cwd_map: CLAUDE_CWD_MAP,
    claude_bin: CLAUDE_BIN,
    bot_user_id: botUserId,
    slack_user_whitelist_enabled: SLACK_USER_WHITELIST.size > 0,
    slack_user_whitelist_count: SLACK_USER_WHITELIST.size,
  });
  console.log(`Slack bot running (Socket Mode). claude="${CLAUDE_BIN}" cwd="${CLAUDE_CWD}"`);
  console.log(`Uploads dir: ${path.resolve(CLAUDE_CWD, 'slack-uploads')}`);
  console.log(`Outputs dir: ${path.resolve(CLAUDE_CWD, 'slack-outputs')}`);
  console.log(`Log file:    ${LOG_FILE}`);
  if (CLAUDE_CWD_MAP.length > 0) {
    console.log(`CWD phrase map (${CLAUDE_CWD_MAP.length}):`);
    for (const e of CLAUDE_CWD_MAP) {
      console.log(`  "${e.phrase}" -> ${e.cwd}`);
    }
  }
  if (SLACK_USER_WHITELIST.size > 0) {
    console.log(`Allowed Slack users: ${SLACK_USER_WHITELIST.size}`);
  } else {
    console.log('Allowed Slack users: all');
  }
})();
