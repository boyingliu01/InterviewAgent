# Dialog Survey

> **Turn DingTalk conversations into structured intelligence.**
>
> An AI-powered survey dialog bot that conducts async multi-turn conversations via DingTalk — with LLM-driven follow-ups, context memory, and automated report generation.

[![Version](https://img.shields.io/badge/version-1.8.1-blue)](https://github.com/boyingliu01/dialog-survey)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

---

## Quickstart

```bash
# One-line install — interactive prompts for each value
npx dialog-survey install

# Start the service
npx dialog-survey start

# That's it. Your dialog bot is live on DingTalk.
```

**Prerequisites:** Node.js >= 20, PostgreSQL 14+, a DingTalk application (Client ID/Secret/Agent ID).

---

## Why — 为什么做这个项目？

**One-on-one conversations are great.** People enjoy real dialogue — a skilled facilitator builds rapport, reads between the lines, and asks exactly the right follow-up. But sitting down with hundreds or thousands of people one by one is expensive and doesn't scale.

**Surveys scale beautifully**, but they're shallow. A fixed questionnaire can't pivot when a respondent says something unexpected.

Dialog Survey fills the gap between these two. It's **deeper than a form, broader than a human-led session.** An AI-powered dialog bot probes interesting responses like a skilled facilitator would, while reaching hundreds of participants in parallel via DingTalk. It won't replace a great human conversation — but when you need structured, first-hand insights from a large group, it's the closest thing without hiring an army of researchers.

---

## What — 这个项目是什么？

Dialog Survey is an **async survey dialog bot** that lives inside DingTalk. You design a survey template, invite participants, and the AI conducts a multi-turn conversation with each person — asking initial questions, probing deeper on interesting answers, and remembering context across days and messages.

### Key Capabilities

| Capability | Description |
|-----------|-------------|
| **AI-driven follow-ups** | LLM-powered intelligent probing — when a participant says something interesting, the bot digs deeper automatically |
| **Multi-turn context memory** | Coherent conversations that span days and multiple messages, not isolated Q&A rounds |
| **Async messaging** | Participants answer in their spare time on DingTalk — no scheduled calls, no pressure |
| **Auto report generation** | Markdown reports generated automatically after dialogs complete — PDF/Excel export via Playwright |
| **Self-hosted** | All data stays on your infrastructure. PostgreSQL, your LLM (ollama / vLLM / cloud), your DingTalk app |

### What's New (v1.8.x)

- **v1.8.1** — Full project doc refresh: compressed AGENTS.md to 88 lines, added subdirectory AGENTS.md for repositories/integrations/utils
- **v1.8.0** — Removed unused ASR/voice recognition. Fixed COMPLETED dialogs stuck in CONTINUE loop. Fixed maxFollowups not persisted to DB. Fixed add-member modal swallowing errors silently.
- **v1.7.9** — CI stability: fixed flaky integration tests, cleaned up secrets from sample configs
- **v1.7.8** — Unified tsconfig.json, fixed 81 type errors across 35 files

> Full changelog in [CHANGELOG.md](./CHANGELOG.md).

---

## How — 怎么使用这个项目？

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Conversation Engine** | Custom LangGraph-inspired workflow (not StateGraph API) |
| **LLM** | OpenAI-compatible API — ollama / vLLM / LocalAI / cloud |
| **Messaging** | DingTalk Stream Mode (WebSocket) |
| **Database** | PostgreSQL + Prisma ORM |
| **Web Framework** | Fastify 5.x |
| **Templates** | Nunjucks (admin UI) |
| **Language** | TypeScript (strict mode, ESM) |

---

### Installation

#### Option A: Quick CLI (recommended for production)

```bash
# Interactive
npx dialog-survey install

# Non-interactive (CI / automation)
npx dialog-survey install \
  --db-url "postgresql://user:pass@localhost:5432/dialog_survey" \
  --dingtalk-client-id "xxx" \
  --dingtalk-client-secret "xxx" \
  --dingtalk-agent-id "xxx"
```

This generates `.env`, runs `prisma generate` + `db push`, and sets up PM2 (Linux/macOS) or direct node launch (Windows).

#### Option B: Docker Compose (recommended for evaluation)

```bash
cp .env.example .env
# Fill in your DingTalk + LLM config
docker compose up -d
curl http://localhost:3001/health
```

#### Option C: Manual setup (development)

```bash
git clone https://github.com/boyingliu01/dialog-survey
cd dialog-survey
npm install
cp .env.example .env
# Edit .env with your config
npx prisma generate && npx prisma db push
npm run dev
```

---

### Lifecycle Management

```bash
npx dialog-survey start     # Start service
npx dialog-survey stop      # Stop service
npx dialog-survey status    # Check status
npx dialog-survey uninstall # Remove completely (data preserved)
npx dialog-survey help      # View all commands
```

---

### Configuration

Key environment variables (see `.env.example` for the full list):

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/dialog_survey` |
| `LLM_BASE_URL` | LLM endpoint (OpenAI-compatible) | `http://localhost:11434/v1` |
| `LLM_MODEL` | Model name | `qwen2.5` |
| `DINGTALK_CLIENT_ID` | DingTalk Client ID | From DingTalk Open Platform |
| `DINGTALK_CLIENT_SECRET` | DingTalk Client Secret | From DingTalk Open Platform |
| `DINGTALK_AGENT_ID` | DingTalk Agent ID | From DingTalk Open Platform |
| `ADMIN_API_KEY` | Admin panel API key | Your custom key |

> Leave `LLM_API_KEY` empty to use a local LLM at `http://localhost:11434/v1`.

---

### Admin Authentication

The admin UI requires authentication. Configure the following environment variables:

```bash
# Admin credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=$2a$12$...  # Generate with bcrypt

# Session configuration
SESSION_SECRET=<32-char-random-string>
SESSION_SALT=<16-char-random-string>
SESSION_MAX_AGE=28800  # 8 hours in seconds
```

#### Generate Password Hash

```bash
node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('your-password', 12).then(console.log)"
```

Copy the output hash and set it as `ADMIN_PASSWORD_HASH`.

#### Generate Session Secret and Salt

```bash
# Generate SESSION_SECRET (32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate SESSION_SALT (16 bytes)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

#### Access the Admin UI

1. Navigate to `http://localhost:3001/admin`
2. Enter your username and password
3. You will be redirected to the admin dashboard

#### Session Management

- Sessions expire after 8 hours of inactivity (configurable via `SESSION_MAX_AGE`)
- Session data is stored in encrypted cookies (no server-side storage)
- To logout, navigate to `/admin/logout` or clear your browser cookies

#### API Key Backward Compatibility

API access via `X-Admin-Key` header is still supported for backward compatibility with existing scripts and integrations:

```bash
curl -H "X-Admin-Key: your-api-key" http://localhost:3001/admin
```

#### Security Features

- **CSRF Protection**: All form submissions include CSRF tokens automatically
- **Session Timeout**: Inactive sessions expire after 8 hours
- **Encrypted Cookies**: Session data is encrypted and signed
- **Password Hashing**: Passwords are hashed using bcrypt (cost factor 12)

---

### Production Deployment

**Linux / macOS** (PM2):
```bash
npm run build
pm2 start dist/src/server.js --name dialog-survey
pm2 save && pm2 startup
```

**Windows** (direct node):
```bash
npm run build
node dist/src/server.js
```

**Docker**:
```bash
docker compose up -d
docker compose logs -f app
```

Health check: `curl http://localhost:3001/health`

---

### Development Commands

```bash
npm run dev          # Hot-reload dev server on :3001
npm run type-check   # TypeScript check (tsc --noEmit)
npm test             # Run tests (Vitest)
npm run lint         # Biome lint
npm run build        # Compile to dist/
npm run smoke        # Quick sanity check (type-check + lint + key tests)
```

---

### Project Structure

```
dialog-survey/
├── src/
│   ├── api/          # Fastify routes
│   ├── core/         # Graph workflow engine
│   ├── services/     # Business logic (18 services)
│   ├── repositories/ # Data access (Prisma)
│   ├── integrations/ # DingTalk + LLM clients
│   ├── middleware/   # Fastify middleware
│   ├── views/        # Nunjucks admin UI (HTMX + Alpine.js)
│   └── utils/        # Helpers (logger, security, PII, etc.)
├── tests/            # 92 files, ~930 tests (Vitest)
├── scripts/          # CLI binary + deploy scripts
├── prisma/           # Schema + migrations + seeds
└── docs/             # Architecture & design docs
```

---

### Further Reading

- [DEPLOY.md](./DEPLOY.md) — Detailed deployment guide
- [AGENTS.md](./AGENTS.md) — Codebase map for AI agents
- [CHANGELOG.md](./CHANGELOG.md) — Full release history
- [Architecture](./architecture.yaml) — Architecture validation rules

---

## License

MIT
