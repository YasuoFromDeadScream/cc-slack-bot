# ClaudeCode と連携する SlackBot

ローカルで動く Slack bot。メッセージを受けると Claude Code CLI (`claude -p`) に渡して、その応答を返します。

## 仕組み

- `@slack/bolt` の **Socket Mode**（公開URL不要）
- メンション (`@bot ...`) または **DM** に反応
- Claude Code を `child_process.spawn` で起動し、結果をスレッドに返信
- スレッドごとに `session_id` を保持して文脈を維持（`claude --resume`）

## セットアップ

### 1. 依存インストール

このプロジェクトは **pnpm** を使用します（Corepack 経由でバージョン固定済み）。

bash では `~/.bashrc` に以下のエイリアスを定義しておけば `pnpm` が直接使えます（本リポジトリ開発時に既に設定済み）：

```bash
alias pnpm='corepack pnpm'
```

新しい bash シェルを開いたら：

```bash
pnpm install
```

エイリアスを使わない場合は `corepack pnpm install` でも同等です。

### 2. Slack アプリ作成

<https://api.slack.com/apps> → **Create New App** → From scratch

- **Socket Mode**: ON（App-Level Token を発行、scope は `connections:write`）→ `xapp-...` を `SLACK_APP_TOKEN` に
- **OAuth & Permissions** → Bot Token Scopes に以下を追加：
  - `app_mentions:read`
  - `chat:write`
  - `im:history`
  - `im:read`
  - `im:write`
  - `files:read` ← ファイル添付を扱う場合に必須
  - `files:write` ← Claude が生成したファイルを返す場合に必須
- **Event Subscriptions**: ON、Subscribe to bot events:
  - `app_mention`
  - `message.im`
- ワークスペースに Install → Bot User OAuth Token `xoxb-...` を `SLACK_BOT_TOKEN` に
- **Basic Information** → Signing Secret を `SLACK_SIGNING_SECRET` に

### 3. 環境変数

```bash
cp .env.example .env
# .env を編集してトークンを書く
```

特定ユーザーだけに bot を使わせたい場合は、`.env` に `SLACK_USER_WHITELIST` を追加します。

```bash
SLACK_USER_WHITELIST=U01234567,U08999999
```

カンマ区切りまたは空白区切りで複数指定できます。未設定のままなら全ユーザー許可です。

### 4. 起動

```bash
pnpm start
# または自動リロード
pnpm dev
```

`⚡ Slack bot running (Socket Mode).` と表示されれば OK。

## 使い方

- チャンネルで `@bot こんにちは` とメンション
- bot に DM を送信
- **ファイル添付も OK** — 画像・テキスト・コード等を付けると `slack-uploads/<thread_ts>/` にダウンロードされ、そのローカルパスをプロンプトに含めて Claude Code に渡します（Claude 側で Read tool で読み込めます）
- **Claude からのファイル返却も OK** — プロンプトで `OUTPUT_DIR` を伝えるので、Claude がそこに書き出したファイルは自動で Slack にアップロードされます（100MB 超はスキップ）
- bot は同じスレッドで応答し、スレッド内では会話履歴が保持されます

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✓ | `xoxb-...` |
| `SLACK_APP_TOKEN` | ✓ | `xapp-...`（Socket Mode 用） |
| `SLACK_SIGNING_SECRET` | ✓ | Basic Information にある Signing Secret |
| `CLAUDE_BIN` |  | claude CLI のパス（デフォルト: PATH の `claude`） |
| `CLAUDE_CWD` |  | Claude Code の作業ディレクトリ |
| `CLAUDE_EXTRA_ARGS` |  | 追加引数（例: `--model sonnet`） |
| `SLACK_USER_WHITELIST` |  | 許可する Slack user ID 一覧。カンマ区切りまたは空白区切り。未設定時は全ユーザー許可 |

## セキュリティ

[.npmrc](.npmrc) で以下を強制しています：

- **`ignore-scripts=true`** — 依存パッケージの `preinstall` / `postinstall` などのライフサイクルスクリプトをデフォルトで無効化（供給網攻撃の主要経路を塞ぐ）。許可したいパッケージは [package.json](package.json) の `pnpm.onlyBuiltDependencies` に明示する
- **`engine-strict=true`** — `engines` フィールドに合わない Node/pnpm では install を失敗させる
- **`strict-peer-dependencies=true`** — peer dependency の不整合を警告ではなくエラーにする
- **`audit-level=moderate`** — 中以上の脆弱性があれば `pnpm audit` が非ゼロ終了（`pnpm audit` スクリプトで実行可）
- **`packageManager`** フィールドに pnpm のバージョン + SHA512 を固定 → Corepack が起動時にハッシュ検証する

定期的に脆弱性チェック：

```bash
pnpm audit
pnpm outdated   # 古くなっている依存の確認
```

## 工夫したポイント

- `SLACK_USER_WHITELIST` を追加し、指定した Slack user ID のみ利用できるようにした

