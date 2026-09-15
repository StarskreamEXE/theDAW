import assert from 'node:assert/strict';

// Storage budget for the shim below, in characters. `Infinity` = never full.
// Tests lower it to drive the quota-trim path in writeAll().
let BUDGET = Infinity;
// When set, the shim throws this instead of a quota error (non-quota path).
let FORCE_ERROR: Error | null = null;
// Number of setItem calls, so a test can prove there was no retry loop.
let setItemCalls = 0;

// Minimal in-memory localStorage for the node/tsx test env. Runs before any
// chatHistory function is called (module bodies don't touch storage at import).
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
    const store = new Map<string, string>();
    const totalWith = (k: string, v: string) => {
        let total = k.length + v.length;
        for (const [ek, ev] of store) if (ek !== k) total += ek.length + ev.length;
        return total;
    };
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
            setItemCalls += 1;
            if (FORCE_ERROR) throw FORCE_ERROR;
            if (totalWith(k, String(v)) > BUDGET) {
                throw new DOMException('quota', 'QuotaExceededError');
            }
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

import {
    loadConversations,
    upsertConversation,
    deleteConversation,
    renameConversation,
    getConversation,
    getActiveId,
    setActiveId,
    deriveTitle,
    clearAllConversations,
    type StoredConversation,
} from './chatHistory.ts';

/** Mirrors the (unexported) key in chatHistory.ts — lets a test read raw. */
const CONV_KEY = 'thedaw:orb:conversations:v1';

function conv(id: string, firstUser: string, updatedAt: number): StoredConversation {
    return {
        id,
        title: deriveTitle([
            { id: 'u', role: 'user', content: firstUser, timestamp: new Date() } as never,
        ]),
        messages: [
            { id: 'u', role: 'user', content: firstUser, timestamp: new Date() } as never,
            { id: 'a', role: 'assistant', content: 'ok', timestamp: new Date() } as never,
        ],
        provider: 'claude',
        model: 'claude-opus-4-6',
        claudeMode: 'interactive',
        sessionId: `sess-${id}`,
        createdAt: updatedAt,
        updatedAt,
    };
}

/** What is physically in the store right now, bypassing loadConversations(). */
function rawStored(): unknown {
    const raw = localStorage.getItem(CONV_KEY);
    return raw === null ? [] : JSON.parse(raw);
}

localStorage.clear();

// deriveTitle: first user line, trimmed
assert.equal(deriveTitle([{ id: '1', role: 'user', content: 'Make a beat', timestamp: new Date() } as never]), 'Make a beat');
assert.equal(deriveTitle([]), 'New chat');
assert.ok(deriveTitle([{ id: '1', role: 'user', content: 'x'.repeat(80), timestamp: new Date() } as never]).endsWith('…'));

// empty to start
assert.deepEqual(loadConversations(), []);

// upsert + load round-trip, newest first
upsertConversation(conv('a', 'first chat', 1000));
upsertConversation(conv('b', 'second chat', 2000));
let all = loadConversations();
assert.equal(all.length, 2);
assert.equal(all[0].id, 'b', 'newest updatedAt sorts first');
assert.equal(all[1].id, 'a');
assert.equal(all[0].sessionId, 'sess-b');

// messages revive to Date instances
assert.ok(all[0].messages[0].timestamp instanceof Date, 'timestamp revived to Date');

// replace by id (not duplicate)
upsertConversation(conv('a', 'first chat edited', 3000));
all = loadConversations();
assert.equal(all.length, 2, 'upsert replaces same id, no dupe');
assert.equal(all[0].id, 'a', 'a is now newest');

// rename
renameConversation('a', 'Renamed');
assert.equal(getConversation('a')?.title, 'Renamed');

// active id
setActiveId('a');
assert.equal(getActiveId(), 'a');

// delete clears active if it was active
deleteConversation('a');
assert.equal(getConversation('a'), null);
assert.equal(getActiveId(), null, 'deleting the active convo clears activeId');
assert.equal(loadConversations().length, 1);

// clearAllConversations wipes every stored convo + the active pointer
upsertConversation(conv('c', 'third chat', 4000));
upsertConversation(conv('d', 'fourth chat', 5000));
setActiveId('d');
assert.equal(loadConversations().length, 3, 'b, c, d stored before clear');
clearAllConversations();
assert.deepEqual(loadConversations(), [], 'clear wipes all conversations');
assert.equal(getActiveId(), null, 'clear wipes the active id');

// --- deleting the ONLY conversation actually persists the empty list -------
localStorage.clear();
BUDGET = Infinity;
upsertConversation(conv('solo', 'only chat', 1000));
assert.equal(loadConversations().length, 1, 'one conversation stored');
const afterDelete = deleteConversation('solo');
assert.deepEqual(afterDelete, [], 'deleteConversation returns the empty list');
assert.deepEqual(loadConversations(), [], 'last delete is reflected on reload');
assert.deepEqual(rawStored(), [], 'last delete is persisted, not just returned');

// --- quota: trims oldest until the write fits -----------------------------
const pad = 'y'.repeat(200);
localStorage.clear();
BUDGET = Infinity;
upsertConversation(conv('q1', `one ${pad}`, 1000));
upsertConversation(conv('q2', `two ${pad}`, 2000));
upsertConversation(conv('q3', `thr ${pad}`, 3000));
const len3 = localStorage.getItem(CONV_KEY)!.length;
localStorage.clear();
upsertConversation(conv('q1', `one ${pad}`, 1000));
upsertConversation(conv('q2', `two ${pad}`, 2000));
const len2 = localStorage.getItem(CONV_KEY)!.length;
assert.ok(len3 > len2, 'three conversations serialize larger than two');
// A budget strictly between two and three conversations: the 3-item write
// throws, the trimmed 2-item write fits.
BUDGET = CONV_KEY.length + len2 + Math.floor((len3 - len2) / 2);
const trimmed = upsertConversation(conv('q3', `thr ${pad}`, 3000));
assert.deepEqual(
    trimmed.map((c) => c.id),
    ['q3', 'q2'],
    'quota trims the oldest and keeps the newest two',
);
assert.deepEqual(
    loadConversations().map((c) => c.id),
    ['q3', 'q2'],
    'the trimmed list is what actually persisted',
);

// --- quota: total failure returns the PRE-EXISTING stored list ------------
const huge = 'z'.repeat(50000);
const before = loadConversations().map((c) => c.id);
const failed = upsertConversation(conv('big', huge, 9000));
assert.deepEqual(
    failed.map((c) => c.id),
    before,
    'a write that cannot fit returns what storage holds, never the unsaved list',
);
assert.ok(!failed.some((c) => c.id === 'big'), 'the unsaved conversation is not reported as saved');
assert.deepEqual(
    loadConversations().map((c) => c.id),
    before,
    'storage is unchanged after a total write failure',
);

// --- non-quota error: warn once, no retry loop ----------------------------
BUDGET = Infinity;
FORCE_ERROR = new Error('storage disabled');
const warnings: unknown[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
    warnings.push(args[0]);
};
setItemCalls = 0;
const kept = loadConversations().map((c) => c.id);
const nonQuota = upsertConversation(conv('nq', 'nope', 9999));
console.warn = realWarn;
FORCE_ERROR = null;
assert.equal(setItemCalls, 1, 'a non-quota error is not retried');
assert.equal(warnings.length, 1, 'a non-quota error warns exactly once');
assert.deepEqual(
    nonQuota.map((c) => c.id),
    kept,
    'a non-quota failure returns the stored list, not the unsaved one',
);

// --- MAX_CONVERSATIONS cap keeps the newest -------------------------------
localStorage.clear();
BUDGET = Infinity;
for (let i = 1; i <= 105; i += 1) upsertConversation(conv(`m${i}`, `chat ${i}`, i * 1000));
const capped = loadConversations();
assert.equal(capped.length, 100, 'stored list is capped at MAX_CONVERSATIONS');
assert.equal(capped[0].id, 'm105', 'newest survives the cap');
assert.equal(capped[99].id, 'm6', 'the oldest five were trimmed');
assert.equal(getConversation('m1'), null, 'trimmed conversations are gone');

// --- garbage in the store never throws and never leaks -------------------
for (const garbage of ['not json', '{"a":1}', '[null]']) {
    localStorage.clear();
    localStorage.setItem(CONV_KEY, garbage);
    assert.deepEqual(loadConversations(), [], `garbage ${garbage} yields an empty list`);
}

// --- corrupt message fields revive to usable values ----------------------
localStorage.clear();
localStorage.setItem(
    CONV_KEY,
    JSON.stringify([
        {
            id: 'x',
            title: 'corrupt',
            messages: [
                { id: 'm', role: 'user', content: 42, timestamp: 'not-a-date' },
                null,
                { id: 'n', role: 'assistant', content: 'ok' },
            ],
            provider: 'claude',
            model: 'claude-opus-4-6',
            claudeMode: 'interactive',
            sessionId: null,
            createdAt: 1,
            updatedAt: 1,
        },
    ]),
);
const revived = loadConversations()[0].messages;
assert.equal(revived.length, 2, 'null messages are dropped');
assert.equal(typeof revived[0].content, 'string', 'non-string content is coerced');
assert.equal(revived[0].content, '42');
assert.ok(revived[0].timestamp instanceof Date);
assert.ok(!Number.isNaN(revived[0].timestamp.getTime()), 'an unparseable timestamp is not Invalid Date');
assert.ok(!Number.isNaN(revived[1].timestamp.getTime()), 'a missing timestamp is not Invalid Date');

localStorage.clear();
BUDGET = Infinity;

console.log('chatHistory: all assertions passed');
