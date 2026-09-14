import React from 'react';

/**
 * The footer's engraved glyphs: fill-only paths on a 14-unit grid, drawn at
 * 14px so every edge lands on a whole device pixel at 1x. Hard corners, no
 * rounded joins (lucide's round joins go soft that small), and currentColor,
 * so a key's ink, hover ink and ON accent flow straight in. PlayerFooter draws
 * the transport from these; LogActionButton (layout/ProcessingLog.tsx) draws
 * STOP, PROCESS and TRAIN from them.
 */
export const Glyph: React.FC<{ d: string; className?: string }> = ({ d, className }) => (
  <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
    <path d={d} />
  </svg>
);

export const GLYPH_PLAY = 'M3 1.5 12.5 7 3 12.5Z';
export const GLYPH_PAUSE = 'M3 2h3v10H3zM8 2h3v10H8z';
export const GLYPH_TO_START = 'M2 2h2v10H2zM12 2 5 7l7 5z';
export const GLYPH_TO_END = 'M2 2l7 5-7 5zM10 2h2v10h-2z';
/** STOP: a 10-unit square, PAUSE's height, square-cornered. */
export const GLYPH_STOP = 'M2 2h10v10H2z';
/** PROCESS: a five-bar waveform, symmetric about its middle bar. */
export const GLYPH_WAVE = 'M0 5h2v4H0zM3 3h2v8H3zM6 1h2v12H6zM9 3h2v8H9zM12 5h2v4h-2z';
/** TRAIN: three rising steps. */
export const GLYPH_STEPS = 'M0 9h4v4H0zM5 5h4v8H5zM10 1h4v12h-4z';
