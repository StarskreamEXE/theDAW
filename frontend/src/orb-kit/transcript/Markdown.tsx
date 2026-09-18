/**
 * Assistant prose renderer.
 *
 * theDAW renders markdown with react-markdown + remark-gfm (the Foundry used a
 * hand-rolled `simpleMarkdown`); this keeps the transcript's prose identical to
 * what AssistantPanel already shipped, including the click-to-copy code blocks,
 * so mounting the new transcript is not also a restyle.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy } from 'lucide-react';

const copyToClipboard = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
};

const PROSE_CLASSES =
    'prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-p:my-1 prose-headings:my-2 ' +
    'prose-ul:my-1 prose-li:my-0 prose-pre:bg-black/50 prose-pre:border prose-pre:border-white/10 ' +
    'prose-pre:p-2 prose-pre:my-2 prose-a:text-primary hover:prose-a:text-primary/80';

export function Markdown({ text }: { text: string }) {
    return (
        <div className={PROSE_CLASSES}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    img({ src, alt, ...props }) {
                        return (
                            <img
                                src={typeof src === 'string' ? src : undefined}
                                alt={alt ?? ''}
                                className="max-w-full h-auto rounded-lg border border-white/10 my-2"
                                {...props}
                            />
                        );
                    },
                    code({ className, children, ...props }) {
                        const raw = String(children);
                        const text = raw.replace(/\n$/, '');
                        // react-markdown v10 removed the `inline` prop, so infer
                        // block vs inline: a fenced block has a language class or a
                        // newline. Test the RAW children — a one-line fence still
                        // ends in "\n", which `text` has stripped.
                        const isBlock = /language-(\w+)/.test(className ?? '') || raw.includes('\n');
                        return isBlock ? (
                            <div className="relative group">
                                <button
                                    type="button"
                                    onClick={() => copyToClipboard(text)}
                                    className="absolute right-2 top-2 p-1.5 bg-white/10 hover:bg-white/20 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                    title="Copy code"
                                    aria-label="Copy code block"
                                >
                                    <Copy size={12} aria-hidden="true" />
                                </button>
                                <code className={className} {...props}>
                                    {children}
                                </code>
                            </div>
                        ) : (
                            <code className={className} {...props}>
                                {children}
                            </code>
                        );
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}
