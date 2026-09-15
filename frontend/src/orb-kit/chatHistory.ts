/**
 * Orb chat history — durable, client-side conversation storage.
 *
 * The assistant panel keeps its live transcript in React state, which is lost
 * on reload. This module persists each conversation to localStorage so the
 * user can reload, close/reopen the app, and resume any past chat.
 *
 * Storage is per-browser (the user chose local-only over a backend store).
 * Everything is best-effort and wrapped so a disabled/full localStorage never
 * throws into the panel — it just degrades to "no history".
 */
import type { Message } from './AssistantPanel';

const CONV_KEY = 'thedaw:orb:conversations:v1';
const ACTIVE_KEY = 'thedaw:orb:activeId:v1';
/** Hard cap on stored conversations; oldest (by updatedAt) are trimmed. */
const MAX_CONVERSATIONS = 100;

export interface StoredConversation {
    id: string;
    /** Human label — derived from the first user message, or renamed. */
    title: string;
    messages: Message[];
    provider: string;
    model: string;
    claudeMode: string;
    /** Backend/Claude-Code session id for resuming server-side context. */
    sessionId: string | null;
    createdAt: number;
    updatedAt: number;
}

function reviveMessages(msgs: unknown): Message[] {
    if (!Array.isArray(msgs)) return [];
    return msgs
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map((m) => ({
            ...(m as unknown as Message),
            // timestamp round-trips through JSON as a string; revive to Date so
            // the Message contract (timestamp: Date) holds for consumers.
            timestamp: m.timestamp ? new Date(m.timestamp as string) : new Date(),
        }));
}

/** All stored conversations, newest-updated first. Never throws. */
export function loadConversations(): StoredConversation[] {
    try {
        const raw = localStorage.getItem(CONV_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((c) => c && typeof c.id === 'string')
            .map((c) => ({ ...c, messages: reviveMessages(c.messages) }))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch {
        return [];
    }
}

/** Write the full list (sorted + capped). On quota error, trims oldest and
 *  retries until it fits. Returns the list actually persisted. On total
 *  failure (even a single conversation will not fit) it returns the list
 *  still in storage, so a failed write is never treated as saved. */
function writeAll(list: StoredConversation[]): StoredConversation[] {
    let capped = [...list]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_CONVERSATIONS);
    while (capped.length > 0) {
        try {
            localStorage.setItem(CONV_KEY, JSON.stringify(capped));
            return capped;
        } catch {
            if (capped.length === 1) break; // one convo still won't fit → give up
            capped = capped.slice(0, capped.length - 1); // drop the oldest, retry
        }
    }
    // Nothing was written — report what storage actually holds, not `capped`.
    return loadConversations();
}

/** First non-empty user line, trimmed to a short title. */
export function deriveTitle(messages: Message[]): string {
    const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
    const base = (firstUser?.content || '').trim().replace(/\s+/g, ' ') || 'New chat';
    return base.length > 48 ? `${base.slice(0, 47)}…` : base;
}

/** Insert or replace a conversation by id; returns the new list. */
export function upsertConversation(conv: StoredConversation): StoredConversation[] {
    const rest = loadConversations().filter((c) => c.id !== conv.id);
    return writeAll([conv, ...rest]);
}

export function deleteConversation(id: string): StoredConversation[] {
    const rest = loadConversations().filter((c) => c.id !== id);
    const written = writeAll(rest);
    if (getActiveId() === id) setActiveId(null);
    return written;
}

export function renameConversation(id: string, title: string): StoredConversation[] {
    const next = loadConversations().map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c,
    );
    return writeAll(next);
}

export function getConversation(id: string | null): StoredConversation | null {
    if (!id) return null;
    return loadConversations().find((c) => c.id === id) || null;
}

export function getActiveId(): string | null {
    try {
        return localStorage.getItem(ACTIVE_KEY);
    } catch {
        return null;
    }
}

export function setActiveId(id: string | null): void {
    try {
        if (id) localStorage.setItem(ACTIVE_KEY, id);
        else localStorage.removeItem(ACTIVE_KEY);
    } catch {
        /* localStorage unavailable — nothing to do */
    }
}

/** Wipe ALL saved conversations + the active pointer off this machine. Backs
 *  the "Clear all history" affordance so transcripts do not persist forever. */
export function clearAllConversations(): void {
    try {
        localStorage.removeItem(CONV_KEY);
        localStorage.removeItem(ACTIVE_KEY);
    } catch {
        /* localStorage unavailable — nothing to do */
    }
}
