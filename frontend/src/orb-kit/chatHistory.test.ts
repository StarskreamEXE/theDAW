import assert from 'node:assert/strict';

// Minimal in-memory localStorage for the node/tsx test env. Runs before any
// chatHistory function is called (module bodies don't touch storage at import).
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

console.log('chatHistory: all assertions passed');
