/**
 * The panel's pure render decisions.
 *
 * AssistantPanel no longer decides how a MESSAGE looks — the ported
 * `Transcript` owns that, and `shouldShowMessageActions` in
 * transcript/display.ts is the rule that killed the empty bubble with a
 * Copy/Retry row under it. What is left in the panel are two decisions about
 * its own chrome, and they are exported so a test can pin them instead of
 * leaving them buried in JSX:
 *
 *   - which provider gets the permission-mode dropdown, and
 *   - what the composer footer's status line says.
 *
 * The second one exists because status used to render as a fake assistant
 * message row ("Thinking..." with an avatar) in the transcript. There is now
 * exactly ONE live indicator — the Transcript's — and `statusText` appears
 * only here, in the composer footer.
 *
 *   cd frontend && npx tsx src/orb-kit/AssistantPanel.render.test.ts
 */
import assert from 'node:assert/strict';

// The panel's module graph reaches zustand `persist` stores, which read
// localStorage as soon as they are created. Give them one before importing.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
            store.set(k, String(v));
        },
        removeItem: (k: string) => {
            store.delete(k);
        },
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
            return store.size;
        },
    } as Storage;
}

const { shouldShowPermissionSelect, composerStatusLine, composerStatusIsLiveRegion, seedConversationId } =
    await import('./AssistantPanel.tsx');

/** Defaults for the composer-status helpers; each case overrides what it tests. */
const idle = {
    isStreaming: false,
    statusText: null as string | null,
    queuedCount: 0,
    hasLiveContent: false,
    localStatus: null as string | null,
};

// ---------------------------------------------------------------------------
// shouldShowPermissionSelect — permission modes are a Claude Code feature
// ---------------------------------------------------------------------------

assert.equal(shouldShowPermissionSelect('claude'), true, 'the Claude Code provider gets the dropdown');

for (const provider of ['gemini', 'openai', 'anthropic', 'grok', 'groq', 'ollama', 'lmstudio', '']) {
    assert.equal(
        shouldShowPermissionSelect(provider),
        false,
        `${provider || '(none)'} has no permission modes — the dropdown must not render`,
    );
}

// ---------------------------------------------------------------------------
// composerStatusLine — the ONLY place statusText is allowed to show
// ---------------------------------------------------------------------------

// Idle: nothing. A status line that lingers after the turn is a lie.
assert.equal(composerStatusLine(idle), null);
assert.equal(
    composerStatusLine({ ...idle, statusText: 'Running Bash', queuedCount: 2 }),
    null,
    'a stale status from the finished turn is not shown',
);

// Turn start, nothing streamed yet: the transcript's live row already renders a
// "Thinking…" indicator. A second one here would be a SECOND aria-live region
// announcing at the same moment.
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: null, hasLiveContent: false }),
    null,
    'no composer line while the transcript indicator is the only thing on screen',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: 'Running Bash', hasLiveContent: false }),
    null,
    'even a real status waits until the live row has content of its own',
);

// Once the turn has produced something, the transcript stops rendering its
// indicator and the composer line takes over.
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: 'Running Bash', hasLiveContent: true }),
    'Running Bash',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: null, hasLiveContent: true }),
    'Working…',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: '   ', hasLiveContent: true }),
    'Working…',
);

// Queued follow-ups are the user's own pending prompts, and nothing else on
// screen says how many — so they show even before the live row has content.
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: 'Running Bash', hasLiveContent: true, queuedCount: 1 }),
    'Running Bash · 1 queued',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: null, hasLiveContent: false, queuedCount: 3 }),
    'Working… · 3 queued',
);

// Attachment preparation happens BEFORE the turn exists, so nothing else is on
// screen to report it.
assert.equal(
    composerStatusLine({ ...idle, localStatus: 'Preparing 2 attachments…' }),
    'Preparing 2 attachments…',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, hasLiveContent: false, localStatus: 'Attachment failed' }),
    'Attachment failed',
    'a local status outranks the turn — it is the panel reporting its own failure',
);

// ---------------------------------------------------------------------------
// composerStatusIsLiveRegion — exactly ONE aria-live region at any moment
// ---------------------------------------------------------------------------

// While the transcript's "Thinking…" row is up, it owns the announcement; the
// composer line (queue depth) renders as plain text.
assert.equal(
    composerStatusIsLiveRegion({ ...idle, isStreaming: true, hasLiveContent: false, queuedCount: 2 }),
    false,
);
// Once the live row has content it drops its indicator, so the composer line
// becomes the only region and must announce.
assert.equal(composerStatusIsLiveRegion({ ...idle, isStreaming: true, hasLiveContent: true }), true);
assert.equal(composerStatusIsLiveRegion({ ...idle, localStatus: 'Preparing 2 attachments…' }), true);

// ---------------------------------------------------------------------------
// seedConversationId — saved conversation first, sessionStorage as fallback
// ---------------------------------------------------------------------------
// sessionStorage is a single tab-wide slot; the saved conversation is the one
// the user actually reopened. Reading the slot first made reopening chat B
// resume chat A's backend conversation.

assert.equal(seedConversationId({ sessionId: 'conv-from-history' }, 'conv-in-tab'), 'conv-from-history');
assert.equal(seedConversationId({ sessionId: null }, 'conv-in-tab'), 'conv-in-tab', 'a saved chat with no id falls back');
assert.equal(seedConversationId(null, 'conv-in-tab'), 'conv-in-tab', 'no saved chat at all falls back');
assert.equal(seedConversationId(null, null), null);
assert.equal(seedConversationId({ sessionId: '' }, 'conv-in-tab'), 'conv-in-tab', 'an empty id is not an id');
assert.equal(seedConversationId({ sessionId: 'only-history' }, null), 'only-history');

console.log('AssistantPanel render decisions: all assertions passed');
