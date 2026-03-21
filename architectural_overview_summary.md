# Email Production Pipeline — Architectural Overview

**Status:** PoC (v6) — seeking architecture approval before production hardening
**Stack:** n8n (self-hosted Docker) + Google Vertex AI (Gemini 2.5 Flash) + Gmail SMTP + Jira Cloud API + Adobe Campaign
**GCP Project:** tech-and-data-development

---

## What it does

A conversational AI agent that takes Figma HTML exports or design screenshots and produces accessible, dark-mode-ready, brand-validated, email-client-compatible HTML. It validates output against brand guidelines, creates Jira tickets for campaign tracking, sends email proofs, and pushes final deliveries into MarTech platforms (Adobe Campaign).

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
└──────────────┘    │   └─ Run Accessibility Tests (code tool)    │
                    │  Brand validation: via CSS in system prompt  │
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
| **Brand Guidelines Validation** | Built | Prompt-based — the full `brand_guidelines.css` is embedded in the agent's system prompt. The agent validates HTML inline against the CSS values (color palette, type scale, spacing grid, border-radius, email width) and comment blocks (Tone of Voice, Do's/Don'ts). Swap the CSS block in the system prompt to change brands — pipeline logic stays identical. No separate tool node. |

`Run Accessibility Tests` is a **code-based** tool (JavaScript running inside n8n), invoked by the agent via natural language. Brand validation is **prompt-based** — the agent validates directly against CSS embedded in its system prompt. No user action needed for either.

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
| **Persistence** | SQLite DB inside Docker volume. On VM: persistent disk. |
| **Memory** | Buffer window of 8 messages per session. Keeps token budget manageable — large HTML in memory caused iteration loops at higher values. |
| **Max iterations** | 20 (up from default 10). Needed because email HTML generation + tool calls consume multiple iterations. |
| **Session isolation** | Each browser page load generates a UUID session. Memory key: `email-v6`. |

### Target: GCE VM (production)

| Component | Detail |
|-----------|--------|
| **Compute** | GCE e2-micro VM (~$5-7/month) in `europe-north1`, project `tech-and-data-development`. n8n official Docker image via Docker Compose. |
| **Database** | SQLite on the VM's persistent disk. |
| **Chat UI** | `email-chat.html` hosted on Cloud Storage (static site). Webhook URL points to the VM's public IP. Password-gated for manager access. |
| **Auth** | Password gate on the chat UI. n8n admin UI only accessible to developers logged into GCP (via SSH tunnel or IP allowlist — not exposed to the internet). |
| **HTTPS** | Via reverse proxy (e.g. Caddy) or Cloud Load Balancer with managed SSL cert. |
| **Secrets** | `N8N_ENCRYPTION_KEY` set as environment variable on the VM. Must be stable across restarts. |
| **Scaling** | Single instance — sufficient for PoC/demo. |
| **Networking** | Outbound to: Google Vertex AI, Gmail SMTP, Jira Cloud, Adobe Campaign. Inbound: webhook port for chat UI. |

**Migration path:** Export workflow JSON + re-import on VM instance. Re-enter credentials (encrypted to the new `N8N_ENCRYPTION_KEY`). No code changes to the workflow itself.

---

## Security & credentials

| Credential | Storage | Scope |
|------------|---------|-------|
| Google Vertex SA key | n8n credential store (encrypted in Docker volume) | GCP service account: `figma-to-martech-poc@tech-and-data-development.iam.gserviceaccount.com` |
| Gmail SMTP (App Password) | n8n credential store | `vml.map.td.poc@gmail.com` — PoC-only shared mailbox |
| Jira API token | n8n credential store (HTTP Basic Auth) | Personal Atlassian token — each developer generates their own |
| Adobe Campaign auth | Not yet configured | Adam owns this. To be added by him. TBD whether we use a developer's personal operator or a service account operator. |

`commands.txt` (local-only, gitignored) contains reference credentials for developer onboarding.

---

## What's built vs. what's planned

### Built (v6 — current)
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
- [x] Brand guidelines CSS (`brand_guidelines.css`) with Tone of Voice, Do's/Don'ts, 8px baseline grid
- [x] Brand validation via CSS embedded in system prompt (swap CSS block to change brands)

### Planned (post-deploy iterations)
- [ ] **Adobe Campaign endpoint** — Adam owns this. To be added by him. TBD whether we use a developer's personal operator or a service account operator. Pipeline node already in place.
- [ ] **Jira service account** — currently using Niclas's personal API token. Sufficient for manager testing/approval. Will switch to a dedicated service account token before wider rollout.

---

## Decided

- **Chat UI hosting** — Static HTML on Cloud Storage (password-gated). Webhook URL points to GCE VM.
- **Deployment target** — GCE e2-micro VM (~$5-7/month) in europe-north1.
- **Jira auth (PoC)** — Niclas's personal API token. Manager tests and approves in Niclas's name.
- **ACC credentials** — Adam owns this. To be added by him. TBD whether we use a developer's personal operator or a service account operator. Pipeline node already wired.
- **Brand guidelines format** — CSS file (`brand_guidelines.css`). CSS values define the visual rules (colors, type scale, spacing grid). Comment blocks at the top carry Tone of Voice and Do's/Don'ts in plain English. The full CSS is embedded in the agent's system prompt. Swap the CSS block to switch brands — pipeline logic stays identical. Intentionally no component patterns: this tool serves custom one-off campaigns where standard component libraries don't fit (the core use case).
- **Brand Guidelines Validation** — Built. Prompt-based — agent validates inline against CSS in its system prompt. No separate code tool needed. Change the CSS → change the checks.

## Open decisions
1. **Model upgrade** — Gemini 2.5 Flash is fast and cheap. When n8n adds support for newer models (e.g. Gemini 3.x), we can swap with a one-field change.
2. **Jira guidelines** — Where is the agent allowed to create tickets (in specific epic? in a specific jira project?) What content should be in the created tickets.
