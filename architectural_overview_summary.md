# Email Production Pipeline — Architectural Overview

**Status:** PoC (v5) — seeking architecture approval before production hardening
**Stack:** n8n (self-hosted Docker) + Google Vertex AI (Gemini 2.5 Flash) + Gmail SMTP + Jira Cloud API + Adobe Campaign
**GCP Project:** tech-and-data-development

---

## What it does

A conversational AI agent that takes Figma HTML exports or design screenshots and produces accessible, dark-mode-ready, email-client-compatible HTML — then routes the output to email proofing, Jira ticketing, or Adobe Campaign delivery.

Users interact via a lightweight browser-based chat UI. No n8n knowledge required.

---

## Architecture

```
                              ┌─────────────────────────┐
                              │    Browser Chat UI       │
                              │    (email-chat.html)     │
                              └───────────┬─────────────┘
                                          │ HTTP POST (webhook)
                                          ▼
                              ┌─────────────────────────┐
                              │   n8n Chat Trigger       │
                              │   (webhook endpoint)     │
                              └───────────┬─────────────┘
                                          │
                                          ▼
┌──────────────┐    ┌─────────────────────────────────────────────┐
│ Google Vertex │◄──►│            AI AGENT (Gemini 2.5 Flash)      │
│ Gemini LLM   │    │                                             │
└──────────────┘    │  System prompt: email best practices,       │
                    │  POUR accessibility, dark mode, brand       │
┌──────────────┐    │  validation, delivery markers               │
│ Conversation │◄──►│                                             │
│ Memory (8)   │    │  Tools:                                     │
└──────────────┘    │   ├─ Run Accessibility Tests (code tool)    │
                    │   └─ Run Brand Guidelines Check (planned)   │
                    └───────────────────┬─────────────────────────┘
                                        │ Agent output with
                                        │ action markers
                                        ▼
                              ┌─────────────────────────┐
                              │   Extract & Route        │
                              │   (Code node — regex)    │
                              └───────────┬─────────────┘
                                          │
                        ┌─────────────────┼─────────────────┐
                        │                 │                 │
                        ▼                 ▼                 ▼
              ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
              │  :::SEND:::  │  │  :::SHIP:::  │  │ :::TICKET::: │
              │              │  │              │  │              │
              │  Send Email  │  │  Push to     │  │  Create Jira │
              │  (SMTP/465)  │  │  Adobe       │  │  Ticket      │
              │              │  │  Campaign    │  │  (REST API)  │
              └──────────────┘  └──────────────┘  └──────────────┘
              Gmail SMTP         HTTP/SOAP          Jira Cloud v3
              vml.map.td.poc     (ACC endpoint      TAD project
              @gmail.com         TBD)               Basic Auth
```

---

## Agent tools (sub-nodes)

| Tool | Status | What it does |
|------|--------|-------------|
| **Run Accessibility Tests** | Built | Validates POUR compliance: lang attr, heading hierarchy, alt text, dark mode CSS, Outlook selectors, font sizes, link text, DOCTYPE, charset, viewport, 600px width |
| **Run Brand Guidelines Check** | Planned | Validates HTML against uploaded/configured brand rules: color palette (hex match), font stacks, spacing, logo placement, tone. Returns pass/fail report identical in format to accessibility tests. Runs in parallel with accessibility check before delivery. |

Both tools are **code-based** (JavaScript running inside n8n). The agent invokes them via natural language — no user action needed.

---

## Delivery actions

| User says | Marker | Downstream node | Integration |
|-----------|--------|-----------------|-------------|
| "send to niclas.ulfeldt@vml.com" / "proof it" / "preview" | `:::SEND_START:::` | **Send Email** | Gmail SMTP (port 465, SSL). Sends rendered HTML as email body. |
| "ship it" | `:::SHIP_START:::` | **Push to Adobe Campaign** | HTTP POST (SOAP/XML). ACC endpoint TBD — placeholder in place. |
| "create ticket" / "log it" | `:::TICKET_START:::` | **Create Jira Ticket** | REST POST to `wundertracker.atlassian.net/rest/api/3/issue`. Project TAD, type Task. Supports optional epic via `parent.key`. |
| (anything else) | No marker | **Chat Only** | Passes through — normal conversation. |

Routing is sequential IF-chain: Is Send? → Is Ship? → Is Ticket? → Chat Only.

---

## Infrastructure

### Current: Local Docker (PoC)

| Component | Detail |
|-----------|--------|
| **Runtime** | n8n v2.10.4, Docker container, `localhost:5678` |
| **LLM** | Google Vertex AI, Gemini 2.5 Flash, temp 0.2 |
| **Persistence** | Docker named volume (`n8n_n8n_data`) — SQLite DB inside. NOT bind-mounted (OneDrive + SQLite = corruption risk). |
| **Memory** | Buffer window of 8 messages per session. Keeps token budget manageable — large HTML in memory caused iteration loops at higher values. |
| **Max iterations** | 20 (up from default 10). Needed because email HTML generation + tool calls consume multiple iterations. |
| **Session isolation** | Each browser page load generates a UUID session. Memory key: `email-v5`. |

### Target: Cloud Run (production)

| Component | Detail |
|-----------|--------|
| **Compute** | Cloud Run service in `tech-and-data-development` project. n8n official Docker image. |
| **Database** | Cloud SQL (PostgreSQL). n8n requires a persistent DB for workflows, encrypted credentials, execution logs, and conversation memory. Cloud Run containers are ephemeral — without an external DB, all state is lost on every scale-to-zero or redeploy. Config: `DB_TYPE=postgresdb` + connection env vars. |
| **Chat UI** | Hosted on the same Cloud Run service. n8n can serve static files, or email-chat.html is bundled into the container. Webhook URL points to the Cloud Run service URL. |
| **Auth** | GCP IAM on the Cloud Run service (`roles/run.invoker`). Users authenticate via their GCP identity — no separate login. |
| **HTTPS** | Provided by Cloud Run automatically via `*.run.app` domain. Custom domain optional. |
| **Secrets** | `N8N_ENCRYPTION_KEY` stored in Secret Manager — must be stable across deploys or n8n credentials become unreadable. DB connection string also in Secret Manager. |
| **Scaling** | Min instances: 1 (avoid cold starts during working hours). Max instances: configurable. |
| **Networking** | Cloud SQL via private VPC connector. Outbound to: Google Vertex AI, Gmail SMTP, Jira Cloud, Adobe Campaign. |

**Migration path:** Export workflow JSON + re-import on Cloud Run instance. Re-enter credentials (encrypted to the new `N8N_ENCRYPTION_KEY`). No code changes to the workflow itself.

---

## Security & credentials

| Credential | Storage | Scope |
|------------|---------|-------|
| Google Vertex SA key | n8n credential store (encrypted in Docker volume) | GCP service account: `figma-to-martech-poc@tech-and-data-development.iam.gserviceaccount.com` |
| Gmail SMTP (App Password) | n8n credential store | `vml.map.td.poc@gmail.com` — PoC-only shared mailbox |
| Jira API token | n8n credential store (HTTP Basic Auth) | Personal Atlassian token — each developer generates their own |
| Adobe Campaign auth | Not yet configured | Placeholder node — needs ACC URL + credentials |

`commands.txt` (local-only, gitignored) contains reference credentials for developer onboarding.

---

## What's built vs. what's planned

### Built (v5 — current)
- [x] Conversational agent with Gemini 2.5 Flash
- [x] Figma HTML cleanup + design image analysis
- [x] POUR accessibility enforcement + automated test tool
- [x] Dark mode with Outlook compatibility
- [x] Email send/proof via Gmail SMTP
- [x] Jira ticket creation via REST API (with optional epic)
- [x] Adobe Campaign push node (placeholder — needs real endpoint)
- [x] Custom chat UI (email-chat.html)
- [x] Docker deployment with persistent volume
- [x] Git repo with CI-safe .gitignore

### Planned (post-deploy iterations)
- [ ] **Brand Guidelines Check tool** — code tool that validates against configurable brand rules (colors, fonts, spacing, logo). Straightforward addition — deploy first, add in a later iteration.
- [ ] **Adobe Campaign endpoint** — credentials exist but not on hand. Will configure and redeploy once available. Pipeline node is already in place.
- [ ] **Jira service account** — currently using Niclas's personal API token. Sufficient for manager testing/approval. Will switch to a dedicated service account token before wider rollout.

---

## Decided

- **Chat UI hosting** — Bundled into the same Cloud Run container as n8n. Default `*.run.app` domain.
- **Jira auth (PoC)** — Niclas's personal API token. Manager tests and approves in Niclas's name.
- **ACC credentials** — Available but not on hand. Will add and redeploy — pipeline node already wired.
- **Brand Guidelines Check** — Not blocking deployment. Will add as a post-deploy iteration.

## Open decisions

1. **Brand guidelines format** — How should brand rules be provided? Options: JSON config file uploaded to n8n, pasted into chat per-session, or stored in a shared doc the agent reads.
2. **Model upgrade** — Gemini 2.5 Flash is fast and cheap. When n8n adds support for newer models (e.g. Gemini 3.x), we can swap with a one-field change.
3. **Jira guidelines** — Where is the agent allowed to create tickets (in specific epic? in a specific jira project?) What content should be in the created tickets.
