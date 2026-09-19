import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { Transcript } from './Transcript.tsx';
import { PlainToolRow, DiffToolRow } from './ToolRows.tsx';
import { AgentToolCard } from './ToolCallList.tsx';
import { CollapsibleReasoning } from './CollapsibleReasoning.tsx';
import type { PendingDawAction, ToolCallEntry } from '../stream/types.ts';

/**
 * These render through react-dom/server, so they need no DOM and no new
 * dependency — react-dom is already a runtime dep of the app.
 */

const noop = () => {};

function tool(partial: Partial<ToolCallEntry> & { toolId: string }): ToolCallEntry {
    return { name: 'Read', inputJson: '{"file_path":"a.ts"}', status: 'success', ...partial };
}

/** Every id an aria-controls points at must exist in the same markup. */
function assertAriaControlsResolve(markup: string, label: string) {
    const targets = [...markup.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(targets.length > 0, `${label}: expected at least one aria-controls`);
    for (const id of targets) {
        assert.ok(
            markup.includes(`id="${id}"`),
            `${label}: aria-controls="${id}" points at an element that is not rendered`,
        );
    }
}

// ---------------------------------------------------------------------------
// R1 #6 — a collapsed disclosure must still render its controlled element
// ---------------------------------------------------------------------------

{
    const markup = renderToStaticMarkup(<PlainToolRow tool={tool({ toolId: 't1', result: 'ok' })} />);
    assert.match(markup, /aria-expanded="false"/);
    assertAriaControlsResolve(markup, 'PlainToolRow collapsed');
    assert.match(markup, /hidden=""/, 'the collapsed body is hidden, not absent');
}

{
    const markup = renderToStaticMarkup(
        <DiffToolRow
            tool={tool({
                toolId: 't2',
                name: 'Edit',
                inputJson: JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
            })}
        />,
    );
    assertAriaControlsResolve(markup, 'DiffToolRow collapsed');
    assert.match(markup, /hidden=""/);
}

{
    const markup = renderToStaticMarkup(<CollapsibleReasoning thinking="deep thoughts" />);
    assertAriaControlsResolve(markup, 'CollapsibleReasoning collapsed');
    assert.match(markup, /hidden=""/);
    // Collapsed text must still be in the DOM for the control to point at it.
    assert.match(markup, /deep thoughts/);
}

{
    // AgentToolCard defaults OPEN, so its body must be present and NOT hidden.
    const markup = renderToStaticMarkup(
        <AgentToolCard
            tool={tool({
                toolId: 'task1',
                name: 'Task',
                inputJson: JSON.stringify({ subagent_type: 'scout', description: 'look around' }),
                subCalls: [tool({ toolId: 's1' })],
            })}
        />,
    );
    assert.match(markup, /aria-expanded="true"/);
    assertAriaControlsResolve(markup, 'AgentToolCard open');
}

// ---------------------------------------------------------------------------
// R1 #1 — parked T2 actions render DURING the live turn, and are not disabled
// ---------------------------------------------------------------------------

const parked: PendingDawAction = {
    type: 'generate',
    payload: { prompt: 'drums' },
    callId: 'c9',
    description: 'Start audio generation (spends GPU time)',
    sessionId: 'relay-1',
};

function transcript(props: Partial<React.ComponentProps<typeof Transcript>> = {}) {
    return renderToStaticMarkup(
        <Transcript
            messages={[]}
            isStreaming={true}
            liveText=""
            liveThinking=""
            liveToolCalls={[]}
            livePendingActions={[]}
            pendingControls={[]}
            onCopyMessage={noop}
            onRetry={noop}
            onAnswerControl={noop}
            onRunPendingAction={noop}
            onSkipPendingAction={noop}
            {...props}
        />,
    );
}

{
    const markup = transcript({ livePendingActions: [parked] });
    assert.match(markup, /Run ?generate|aria-label="Run generate"/, 'the live Run button is rendered mid-turn');
    assert.match(markup, /aria-label="Skip generate"/);
    assert.match(markup, /Start audio generation/);
    assert.doesNotMatch(
        markup,
        /disabled=""/,
        'the whole point is that a mid-turn action is answerable while streaming',
    );
}

// A message-bound action is likewise answerable while a later turn streams.
{
    const markup = transcript({
        isStreaming: true,
        messages: [{ id: 'm1', role: 'assistant', text: '', pendingActions: [parked], timestamp: 0 }],
    });
    assert.match(markup, /aria-label="Run generate"/);
    assert.doesNotMatch(markup, /disabled=""/);
}

// ---------------------------------------------------------------------------
// The empty-bubble fix, proven in markup
// ---------------------------------------------------------------------------

{
    const markup = transcript({
        isStreaming: false,
        messages: [
            { id: 'm1', role: 'assistant', text: '', toolCalls: [tool({ toolId: 't1' })], timestamp: 0 },
        ],
    });
    assert.doesNotMatch(markup, /aria-label="Copy message"/, 'a tool-only turn has no Copy');
    assert.doesNotMatch(markup, /aria-label="Retry this turn"/);
}

{
    const markup = transcript({
        isStreaming: false,
        messages: [{ id: 'm1', role: 'assistant', text: 'here you go', timestamp: 0 }],
    });
    assert.match(markup, /aria-label="Copy message"/);
    assert.match(markup, /aria-label="Retry this turn"/);
}

console.log('transcript render regression passed');
