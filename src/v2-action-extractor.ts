// V2-action-shape extractor — code-first replacement for the LLM pipeline
// when the source is a known V2 action.
//
// Background: the original 5-stage LLM pipeline (identify → normalize → relate → conflict → persist)
// treats action results as raw text and asks an LLM to invent entity types. For V2's action stream,
// this produces nonsense (e.g. [greeting] for an email about Q3 OKRs, [github_repo_creation]
// wrapping a repo creation) at 55% failure rate (probe #1, 2026-05-17).
//
// This module recognizes V2's action shape (`source: v2-local-actions.<verb>`, `payload:
// {args, result, reasoning}`) and extracts REAL entities + edges deterministically. No LLM
// calls, no JSON parse failures, no nonsense types. ~1ms per ingest instead of ~5 seconds.
//
// Each handler returns:
//   - entities: ordered list, primary first (the "thing" this action centered on)
//   - edges: typed relationships, by entity key (key resolved to id at persist time)
//
// Falls back to null for unknown action verbs — caller continues with the LLM pipeline.

export interface ExtractedEntity {
  /** Stable dedup key: "<type>:<identifier>". Used to find existing nodes for update vs insert. */
  key: string;
  entity_type: string;
  name: string;
  /** Structured fields. Always includes `key` field so getNodesByType + filter finds it again. */
  structured: Record<string, unknown>;
  /** Human-readable description for content field. */
  content: string;
}

export interface ExtractedEdge {
  from_key: string;
  to_key: string;
  type: string;
  weight: number;
  evidence: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
}

interface V2ActionPayload {
  args: unknown;
  result: string | unknown;
  reasoning: string;
}

/** Returns true if the source matches V2's action-name convention. */
export function isV2ActionSource(source: string): boolean {
  return source.startsWith('v2-local-actions.');
}

/** Extract entities + edges from a V2 action ingest. Returns null if no handler matches. */
export function extractFromV2Action(
  source: string,
  payload: unknown,
  cycle: number,
): ExtractionResult | null {
  const action = source.replace(/^v2-local-actions\./, '');
  const handler = HANDLERS[action];
  if (!handler) return null;
  const p = normalizePayload(payload);
  if (!p) return null;
  return handler(p, cycle);
}

function normalizePayload(payload: unknown): V2ActionPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  return {
    args: p.args ?? {},
    result: p.result ?? '',
    reasoning: typeof p.reasoning === 'string' ? p.reasoning : '',
  };
}

/** Parse a result string — may be JSON or "ERROR: {...}". Returns null on failure. */
function parseResult(result: unknown): { ok: boolean; data: Record<string, unknown> | null; errorText: string | null } {
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    return { ok: r.ok === true, data: r, errorText: r.ok === false ? String(r.error ?? '') : null };
  }
  const text = String(result ?? '').trim();
  if (text.startsWith('ERROR')) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as Record<string, unknown>;
        return { ok: false, data: null, errorText: String(parsed.error ?? text) };
      } catch { /* fall through */ }
    }
    return { ok: false, data: null, errorText: text };
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return { ok: parsed.ok !== false, data: parsed, errorText: null };
  } catch {
    return { ok: false, data: null, errorText: 'unparseable_result' };
  }
}

/** Entity key for the cycle the action was taken in — used to attach causation edges. */
function cycleKey(cycle: number): string {
  return `agent_cycle:${cycle}`;
}

function cycleEntity(cycle: number): ExtractedEntity {
  return {
    key: cycleKey(cycle),
    entity_type: 'agent_cycle',
    name: `cycle ${cycle}`,
    structured: { cycle, key: cycleKey(cycle) },
    content: `Agent cycle ${cycle}`,
  };
}

// ── HANDLERS ────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (p: V2ActionPayload, cycle: number) => ExtractionResult> = {};

HANDLERS.github_create_repo = (p, cycle) => {
  const args = (p.args ?? {}) as { name?: string };
  const r = parseResult(p.result);
  const repoFullName = (r.data?.repo as string) ?? (args.name ? `runcor-ai/${args.name}` : 'unknown/unknown');
  const url = (r.data?.url as string) ?? `https://github.com/${repoFullName}`;
  const key = `github_repo:${repoFullName}`;
  return {
    entities: [
      {
        key,
        entity_type: 'github_repo',
        name: repoFullName,
        structured: { key, full_name: repoFullName, name: args.name ?? '', url, created_at_cycle: cycle, ok: r.ok },
        content: `GitHub repo ${repoFullName} at ${url}`,
      },
      cycleEntity(cycle),
    ],
    edges: [
      { from_key: cycleKey(cycle), to_key: key, type: 'created', weight: 1.0, evidence: r.ok ? 'created successfully' : `failed: ${r.errorText}` },
    ],
  };
};

HANDLERS.git_push = (p, cycle) => {
  const args = (p.args ?? {}) as { repo?: string; path?: string; content?: string; commitMessage?: string };
  const r = parseResult(p.result);
  const repoFullName = args.repo ?? (r.data?.repo as string)?.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '') ?? 'unknown';
  const path = args.path ?? (r.data?.path as string) ?? 'unknown';
  const repoKey = `github_repo:${repoFullName}`;
  const fileKey = `github_file:${repoFullName}:${path}`;
  const entities: ExtractedEntity[] = [
    {
      key: fileKey,
      entity_type: 'github_file',
      name: `${repoFullName}/${path}`,
      structured: {
        key: fileKey,
        repo: repoFullName,
        path,
        commit_message: args.commitMessage ?? '',
        last_pushed_cycle: cycle,
        last_push_ok: r.ok,
        content_preview: typeof args.content === 'string' ? args.content.slice(0, 200) : '',
      },
      content: `File ${path} in ${repoFullName}`,
    },
    {
      key: repoKey,
      entity_type: 'github_repo',
      name: repoFullName,
      structured: { key: repoKey, full_name: repoFullName },
      content: `GitHub repo ${repoFullName}`,
    },
    cycleEntity(cycle),
  ];
  const edges: ExtractedEdge[] = [
    { from_key: repoKey, to_key: fileKey, type: 'contains', weight: 1.0, evidence: `${path} pushed at cycle ${cycle}` },
    { from_key: cycleKey(cycle), to_key: fileKey, type: r.ok ? 'committed' : 'attempted_commit_failed', weight: 1.0, evidence: r.ok ? 'pushed' : (r.errorText ?? 'failed') },
  ];
  return { entities, edges };
};

HANDLERS.web_search = (p, cycle) => {
  const args = (p.args ?? {}) as { query?: string };
  const r = parseResult(p.result);
  const query = args.query ?? 'unknown query';
  const queryKey = `search_query:${query.toLowerCase().slice(0, 100)}`;
  const entities: ExtractedEntity[] = [
    {
      key: queryKey,
      entity_type: 'search_query',
      name: query,
      structured: { key: queryKey, query, last_searched_cycle: cycle, succeeded: r.ok },
      content: `Web search: "${query}"`,
    },
  ];
  const edges: ExtractedEdge[] = [
    { from_key: cycleKey(cycle), to_key: queryKey, type: 'searched', weight: 1.0, evidence: r.ok ? 'returned results' : (r.errorText ?? 'failed') },
  ];
  // Extract individual results as entities + edges
  const results = (r.data?.results as Array<Record<string, unknown>> | undefined) ?? [];
  for (const res of results.slice(0, 10)) {
    const url = String(res.url ?? '');
    if (!url) continue;
    const title = String(res.title ?? '');
    const snippet = String(res.snippet ?? '');
    const resultKey = `web_result:${url}`;
    entities.push({
      key: resultKey,
      entity_type: 'web_result',
      name: title || url,
      structured: { key: resultKey, url, title, snippet, first_seen_cycle: cycle },
      content: `${title}: ${snippet}`,
    });
    edges.push({ from_key: queryKey, to_key: resultKey, type: 'returned', weight: 0.9, evidence: 'web search result' });
  }
  entities.push(cycleEntity(cycle));
  return { entities, edges };
};

HANDLERS.firecrawl_scrape = (p, cycle) => {
  const args = (p.args ?? {}) as { url?: string };
  const r = parseResult(p.result);
  const url = args.url ?? 'unknown';
  const pageKey = `webpage:${url}`;
  const title = String(r.data?.title ?? '');
  const markdown = String(r.data?.markdown ?? '');
  return {
    entities: [
      {
        key: pageKey,
        entity_type: 'webpage',
        name: title || url,
        structured: {
          key: pageKey,
          url,
          title,
          markdown_preview: markdown.slice(0, 500),
          last_fetched_cycle: cycle,
          ok: r.ok,
        },
        content: `${title}\n${markdown.slice(0, 1000)}`,
      },
      cycleEntity(cycle),
    ],
    edges: [
      { from_key: cycleKey(cycle), to_key: pageKey, type: 'fetched', weight: 1.0, evidence: r.ok ? 'scraped successfully' : (r.errorText ?? 'failed') },
    ],
  };
};

HANDLERS.fs_write = (p, cycle) => {
  const args = (p.args ?? {}) as { path?: string; content?: string };
  const r = parseResult(p.result);
  const path = args.path ?? 'unknown';
  const fileKey = `scratchpad_file:${path}`;
  return {
    entities: [
      {
        key: fileKey,
        entity_type: 'scratchpad_file',
        name: path,
        structured: {
          key: fileKey,
          path,
          last_modified_cycle: cycle,
          last_action: 'write',
          content_preview: typeof args.content === 'string' ? args.content.slice(0, 500) : '',
          bytes_written: r.data?.bytesWritten ?? null,
        },
        content: `Scratchpad file ${path}`,
      },
      cycleEntity(cycle),
    ],
    edges: [
      { from_key: cycleKey(cycle), to_key: fileKey, type: 'wrote', weight: 1.0, evidence: r.ok ? 'fs_write ok' : (r.errorText ?? 'failed') },
    ],
  };
};

HANDLERS.fs_read = (p, cycle) => {
  const args = (p.args ?? {}) as { path?: string };
  const path = args.path ?? 'unknown';
  const fileKey = `scratchpad_file:${path}`;
  return {
    entities: [
      {
        key: fileKey,
        entity_type: 'scratchpad_file',
        name: path,
        structured: { key: fileKey, path, last_read_cycle: cycle },
        content: `Scratchpad file ${path} (read)`,
      },
      cycleEntity(cycle),
    ],
    edges: [
      { from_key: cycleKey(cycle), to_key: fileKey, type: 'read', weight: 0.7, evidence: 'fs_read' },
    ],
  };
};

HANDLERS.inbox_read = (p, cycle) => {
  const r = parseResult(p.result);
  const messages = (r.data?.messages as Array<Record<string, unknown>> | undefined) ?? [];
  const inboxKey = `inbox_snapshot:cycle-${cycle}`;
  const entities: ExtractedEntity[] = [
    {
      key: inboxKey,
      entity_type: 'inbox_snapshot',
      name: `inbox @ cycle ${cycle}`,
      structured: { key: inboxKey, cycle, message_count: messages.length, ok: r.ok, error: r.errorText },
      content: `Inbox at cycle ${cycle}: ${messages.length} messages${r.ok ? '' : ` — ${r.errorText}`}`,
    },
    cycleEntity(cycle),
  ];
  const edges: ExtractedEdge[] = [
    { from_key: cycleKey(cycle), to_key: inboxKey, type: 'read', weight: 1.0, evidence: r.ok ? `${messages.length} messages` : (r.errorText ?? 'failed') },
  ];
  for (const msg of messages.slice(0, 20)) {
    const subject = String(msg.subject ?? '');
    const from = String(msg.from ?? '');
    const date = String(msg.date ?? '');
    if (!from && !subject) continue;
    const sender = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
    const msgKey = `email_message:${date}:${sender}:${subject}`.slice(0, 250);
    const senderKey = `person:${sender}`;
    entities.push({
      key: msgKey,
      entity_type: 'email_message',
      name: subject || '(no subject)',
      structured: { key: msgKey, subject, from: sender, date, body_preview: String(msg.body ?? '').slice(0, 300) },
      content: `From ${from}, subject: ${subject}`,
    });
    entities.push({
      key: senderKey,
      entity_type: 'person',
      name: sender,
      structured: { key: senderKey, email: sender },
      content: `Person ${sender}`,
    });
    edges.push({ from_key: senderKey, to_key: msgKey, type: 'sent', weight: 1.0, evidence: `subject: ${subject}` });
    edges.push({ from_key: inboxKey, to_key: msgKey, type: 'contains', weight: 1.0, evidence: 'inbox snapshot' });
  }
  return { entities, edges };
};

HANDLERS.email_send = (p, cycle) => {
  const args = (p.args ?? {}) as { to?: string; subject?: string; body?: string };
  const r = parseResult(p.result);
  const to = args.to ?? 'unknown';
  const subject = args.subject ?? '';
  const senderKey = `person:${to}`;
  const threadKey = `email_thread:${to}`;
  const msgKey = `email_message:cycle-${cycle}:to-${to}:${subject}`.slice(0, 250);
  return {
    entities: [
      {
        key: msgKey,
        entity_type: 'email_message',
        name: `to ${to}: ${subject}`,
        structured: { key: msgKey, to, subject, body_preview: (args.body ?? '').slice(0, 300), sent_cycle: cycle, ok: r.ok },
        content: `Sent to ${to}: ${subject}`,
      },
      { key: senderKey, entity_type: 'person', name: to, structured: { key: senderKey, email: to }, content: `Person ${to}` },
      { key: threadKey, entity_type: 'email_thread', name: `thread with ${to}`, structured: { key: threadKey, with: to, last_active_cycle: cycle }, content: `Thread with ${to}` },
      cycleEntity(cycle),
    ],
    edges: [
      { from_key: cycleKey(cycle), to_key: msgKey, type: 'sent', weight: 1.0, evidence: r.ok ? 'sent ok' : (r.errorText ?? 'failed') },
      { from_key: msgKey, to_key: senderKey, type: 'addressed_to', weight: 1.0, evidence: subject },
      { from_key: threadKey, to_key: msgKey, type: 'contains', weight: 1.0, evidence: 'sent message' },
    ],
  };
};

HANDLERS.publish_post = (p, cycle) => {
  const args = (p.args ?? {}) as { title?: string; body?: string };
  const r = parseResult(p.result);
  const slug = (r.data?.slug as string) ?? args.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80) ?? 'untitled';
  const url = (r.data?.url as string) ?? '';
  const key = `blog_post:${slug}`;
  return {
    entities: [
      {
        key,
        entity_type: 'blog_post',
        name: args.title ?? slug,
        structured: { key, slug, title: args.title ?? '', url, body_preview: (args.body ?? '').slice(0, 500), published_cycle: cycle, ok: r.ok },
        content: `Blog post "${args.title}" at ${url}`,
      },
      cycleEntity(cycle),
    ],
    edges: [
      { from_key: cycleKey(cycle), to_key: key, type: 'published', weight: 1.0, evidence: r.ok ? 'published' : (r.errorText ?? 'failed') },
    ],
  };
};

HANDLERS.github_create_issue = (p, cycle) => {
  const args = (p.args ?? {}) as { repo?: string; title?: string; body?: string };
  const r = parseResult(p.result);
  const repo = args.repo ?? 'unknown';
  const number = r.data?.number as number | undefined;
  const url = r.data?.url as string | undefined;
  const repoKey = `github_repo:${repo}`;
  const issueKey = `github_issue:${repo}#${number ?? 'unknown'}`;
  return {
    entities: [
      {
        key: issueKey,
        entity_type: 'github_issue',
        name: `${repo}#${number ?? '?'}: ${args.title}`,
        structured: { key: issueKey, repo, number, title: args.title ?? '', body_preview: (args.body ?? '').slice(0, 300), url, opened_cycle: cycle, ok: r.ok },
        content: `Issue ${repo}#${number}: ${args.title}`,
      },
      { key: repoKey, entity_type: 'github_repo', name: repo, structured: { key: repoKey, full_name: repo }, content: `GitHub repo ${repo}` },
      cycleEntity(cycle),
    ],
    edges: [
      { from_key: cycleKey(cycle), to_key: issueKey, type: 'opened', weight: 1.0, evidence: r.ok ? `#${number}` : (r.errorText ?? 'failed') },
      { from_key: repoKey, to_key: issueKey, type: 'has_issue', weight: 1.0, evidence: '' },
    ],
  };
};
