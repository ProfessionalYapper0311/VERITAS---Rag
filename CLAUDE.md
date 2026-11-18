# CLAUDE.md: Veritas Frontend

## What you are building

Veritas is a multi-tenant, document-chat platform. Employees and clients upload documents (PDF, TXT, etc.), then ask questions and get answers grounded in those documents, with citations. Sensitive actions (for example, deleting a document) are held for human approval. Admins can see approvals, audit events, guardrail blocks and system metrics.

Your job is to build the web frontend only. The backend is already built in FastAPI, along with the ingestion worker, vector store, database and deployment. Do not build, modify or reimplement any of that, and do not create a new backend or server. You build the UI and the thin API client that talks to the existing REST API.

The product name is **Veritas**. Some older architecture diagrams say "Atlas Enterprise AI". Ignore that name; use Veritas everywhere.

## Who uses it

- **Member** (employee or client, scoped to one tenant): chats with documents, uploads documents, views document status, submits requests that need approval.
- **Admin / Approver**: everything a member can do, plus reviewing approval requests, viewing the audit log, guardrail events, and metrics.

Every user belongs to a tenant. A user never sees another tenant's documents, chats or data. The UI should make the current tenant visible (name in the shell) so people always know which workspace they are in.

## Backend (FastAPI, REST over HTTPS)

Base paths already defined:

| Endpoint | Purpose in the UI |
|---|---|
| `/api/chat` | Send a question, get a grounded answer with citations |
| `/api/upload-url` | Get a presigned S3 URL for a direct browser upload |
| `/api/ingest` | Tell the backend an uploaded file is ready to be processed |
| `/api/documents` | List documents and their processing status |
| `/api/approvals` | List, submit, approve and reject human-in-the-loop requests |
| `/api/metrics` | Admin metrics and logs |

**The backend is finished, and its real API is the source of truth. Do not invent request or response shapes.**

1. Read the running server's `/openapi.json` (or `/docs`) and generate TypeScript types from it. If I have given you a path to the backend repo, read the route and schema files there too (read only).
2. If you cannot reach the server or the schema, stop and ask me for the OpenAPI JSON or the Pydantic models instead of guessing. Only if I tell you to proceed without it, define the types in one file (`src/api/types.ts`) and mark each guess with `// ASSUMPTION`.
3. If the API is missing something the UI needs (for example, no way to fetch a source passage for a citation), do not work around it with hacks. Note it in a "Backend gaps" list for me and design the UI to degrade gracefully until I add it.
4. The mock mode in Engineering is for development and showing states the real backend rarely produces (blocked, filtered, pending, errors). It is not a substitute for the real API.

Things the backend does that matter to the UI:

- **Input guardrails** run before the agent: prompt-injection detection, sensitive-query blocking, PII detection, and detection of actions that need human approval. A request can be blocked, or turned into an approval request.
- **Output guardrails** run after: sensitive-info filtering, key-leak prevention, hallucination control, response validation, and tenant-specific rules. A response can be filtered, replaced or flagged.
- **Responses** are grounded answers with citations and references, formatted safely.
- **Chat memory** is stored server-side per conversation, so the UI sends a conversation id rather than the full history.
- **Feedback** (thumbs up or down, optional comment) is stored by the backend.

## Key flows

### Upload

1. User picks or drops a file.
2. Frontend calls `/api/upload-url` and gets a presigned S3 URL.
3. Browser uploads the file straight to S3 (CORS is enabled). The file does not go through FastAPI.
4. Frontend calls `/api/ingest` to start background processing.
5. The document appears in the library with a status that updates until it is ready or has failed. Poll `/api/documents` at a sensible interval, and stop polling when nothing is in progress.

Show real upload progress. Validate file type and size on the client before requesting the URL. A failure at any step needs its own clear message (could not start the upload, the upload failed, processing failed).

### Chat

1. User asks a question. The answer comes back grounded in their tenant's documents, with citations.
2. Citations are the heart of the product. Each one points to a document and, where available, a passage or page.
3. The user can give feedback on each answer.
4. If a request needs approval, the chat shows that clearly (see below) instead of an answer.

Assume a normal JSON response unless the backend turns out to stream. Build the message component so it works either way.

### Human-in-the-loop approval

1. A member makes a sensitive request, such as deleting a document.
2. The backend detects it and creates an approval request with status `pending`.
3. The member sees the request as waiting for approval, with what was asked and when.
4. An admin reviews it and approves or rejects it.
5. The status updates and the decision is written to the audit log.

Members see their own requests and their status. Admins see the queue of everything pending, can approve or reject with an optional note, and can see past decisions.

## Screens

1. **Sign-in and workspace shell.** Navigation for Chat, Documents, Approvals, and (admin only) Admin. Current tenant and user are always visible. Auth method is not specified yet: put sign-in behind a small auth module so it can be swapped, and ask me before choosing one.
2. **Chat.** Conversation list, the conversation itself, and a composer. Answers show citations inline. Selecting a citation opens the source passage beside the conversation without leaving it. Feedback controls sit on each answer. Handles blocked, filtered, pending-approval and error states.
3. **Documents.** Upload area, and a list of documents with name, type, uploaded time and processing status. Row actions include delete, which goes through the approval flow, so the UI must treat it as a request, not an instant action.
4. **Approvals.** Member view: my requests and their status. Admin view: pending queue with approve and reject, plus history.
5. **Admin dashboard.** Metrics (request volume, latency, token usage, errors, document ingestion), the audit log, and guardrail events (what was blocked and why). Traces live in GlassFlow Rius, so link out to it instead of rebuilding it.

Admin screens must be invisible to members, not just disabled. Do not rely on the UI for security; the backend enforces it.

## States every screen must handle

Design these deliberately, not as afterthoughts:

- **Loading** that matches the shape of the content (no generic spinners on whole pages).
- **Empty**: no documents yet, no conversations yet, nothing pending. Each one tells the user what to do next.
- **Error**: say what failed and what the user can do. No vague "Something went wrong". Errors do not apologize.
- **Processing**: a document being ingested, with a status the user can trust.
- **Blocked by input guardrail**: the question was not answered. Explain in plain language without exposing guardrail internals, and let the user rephrase.
- **Filtered by output guardrail**: part or all of an answer was withheld. Say so.
- **Pending approval**: the action has not happened yet. Make that unmistakable.
- **Offline or backend unreachable.**

## Design direction

Make this look like a product with a point of view, not a template.

**The idea.** Veritas is about trust: every answer can be traced back to a source. The memorable thing in this interface should be the **citation experience**: how an answer, its citations and the source passage relate to each other on screen. Spend most of your design effort there and keep everything else quiet and disciplined.

**Process.** Before writing any code, write a short design plan: a palette of 4 to 6 named hex values, the typefaces and their roles, a layout concept with ASCII wireframes for Chat and Documents, and the principles that make it distinct. Then check the plan against this brief. If any part reads like the default you would produce for any AI chat app, change it and say what you changed. Show me the plan, then build.

**Suggested starting point (you may deviate, with a reason):**

- Palette: a deep ink blue for text and structure, a cool near-white paper for surfaces, and a verdigris teal as the single accent meaning "verified or grounded". Semantic colors only where they carry meaning: amber for pending approval, brick red for blocked or failed, and teal for ready.
- Type: a serif for answers and headings (for example Newsreader) because answers are read, not skimmed, and a clean sans (for example Instrument Sans) for interface text. Keep body lines under about 75 characters. Give serif body text a little more line height.
- Layout: chat on the left and a source panel on the right that opens when a citation is selected. On mobile the source panel becomes a bottom sheet.

**Avoid these common tells of generated interfaces:**

- A warm cream background with a terracotta accent, or near-black with a single acid-green accent.
- Identical rounded cards with the same soft shadow for every piece of content, and gradient washes as decoration.
- A tracked-out all-caps label above every heading, numbered markers on content that is not a sequence, and arrows appended to every button.
- A purple-to-blue gradient "AI" look, sparkle icons, and robot avatars.
- Fade-and-slide entrance animations on every section and hover effects on every card.

**Motion.** Use one deliberate moment at most (for example, how a citation connects to its source passage). Beyond that, motion should respond to something the user did: opening a panel, expanding a row, confirming an action. Respect `prefers-reduced-motion`.

**Quality floor (do not announce, just meet it):** responsive down to a 360px phone, full keyboard navigation with visible focus, WCAG AA contrast, proper labels and roles, and a color palette that holds up in both light and dark mode. Dark mode is a real theme, not an inversion.

## Copy

Write from the user's point of view in plain language. Use sentence case and active voice. A button says exactly what happens: "Upload document", "Request deletion", "Approve". Keep the same word for the same action everywhere. If a button says "Request deletion", the confirmation says "Deletion requested" and the status says "Waiting for approval". Never show internal terms (embeddings, chunks, guardrails, vector index) to members. Admins may see "guardrail" since it is part of their job.

## Engineering

Defaults, unless I say otherwise:

- React with TypeScript, built with Vite.
- Tailwind CSS with design tokens defined once as CSS variables (color, type scale, spacing, radius). Light and dark themes come from the same tokens.
- TanStack Query for server state; keep client state minimal.
- React Router for navigation.
- A single typed API client in `src/api/`, one function per endpoint. Components never call `fetch` directly.
- A mock mode (`VITE_USE_MOCKS=true`) that serves realistic fixtures for every endpoint, including the blocked, filtered, pending and error cases, so every state in this document can be seen without a backend.
- Configuration through environment variables (`VITE_API_BASE_URL` and so on). No secrets in the frontend, ever.
- Accessible component primitives (for example Radix or React Aria) for dialogs, menus, tabs and tooltips rather than hand-rolled ones.
- Render answer text as sanitized markdown. Never use `dangerouslySetInnerHTML` on model output.
- Do not log message content or document content to the console in production.

Suggested structure:

```
src/
  api/          typed client, types, mocks
  components/   shared UI (Citation, SourcePanel, StatusBadge, EmptyState...)
  features/     chat/, documents/, approvals/, admin/
  lib/          utilities
  styles/       tokens, global styles
```

## How to work with me

1. Read this file fully, then inspect the existing repo (if any) before proposing anything.
2. Ask me at most a few short questions about real unknowns (auth method, whether chat streams, hosting for the frontend). For everything else, make a decision, state it in one line, and continue.
3. Post the design plan first, then build in this order: design tokens and shell, Chat with the citation experience, Documents with upload, Approvals, Admin.
4. After each stage, run the build, type-check and lint, and fix what fails. Check the result at phone and desktop widths.
5. Keep commits small and described in plain language.
6. When you finish, list: what is built, what is mocked, any `// ASSUMPTION` about the API, any backend gaps you found, and anything you could not verify.

## Out of scope

- Any change to the FastAPI backend, the ingestion worker, Pinecone, PostgreSQL, Bedrock, S3 or the CI/CD pipeline.
- Rebuilding observability. Link to GlassFlow Rius for traces.
- Features not described here. If you think one is missing, suggest it at the end rather than building it.