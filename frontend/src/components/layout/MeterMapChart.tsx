/**
 * The meter map, drawn.
 *
 * One SVG, three rows: a time ruler with amber tempo-change flags above the
 * ticks (two rows, so a change at 2:27 never sits on the 2:30 label); a lane
 * of meter blocks sized by time, coloured by the family of their written
 * numerator, hatched when the reading is a guess (confidence under 0.10),
 * labelled with signature and grouping, badged 8TH or 16TH when read at the
 * tatum; and a lane of syncopation per bar (Longuet-Higgins & Lee, read on the
 * low band against the pulse).
 *
 * `drawMeterMap` is a pure function of the data and a width, so the same
 * drawing goes on screen (measured to the block's width, with hover and focus
 * handing the block's numbers to a detail line) and into a file at a fixed
 * width, framed with the title, the facts, the chips and the legend.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FAMILY_COLOUR,
  FAMILY_WORDS,
  LEGEND_ORDER,
  ROWS,
  SYNC_COLOUR,
  TEMPO_COLOUR,
  chartHeight,
  chipsFor,
  describeSegment,
  factsFor,
  familyOf,
  labelFit,
  levelMark,
  mmss,
  numeratorOf,
  segmentLabel,
  ticksFor,
  type Chip,
  type MapSegment,
  type MeterMapData,
} from '../../lib/meterMapLayout';
import { standaloneHtml } from '../../lib/exportPicture';

const INK = '#0c0b12';
const PANEL = '#151320';
const LANE_BG = '#1c1929';
const LINE = '#2a2637';
const LINE_STRONG = '#3b3650';
const TEXT = '#ece8f3';
const MUTED = '#8f89a3';
const FAINT = '#7a7490';
const CHIP_LINE: Record<Chip['kind'], string> = { poly: FAMILY_COLOUR.mx, cross: FAMILY_COLOUR.m3, swing: TEMPO_COLOUR };

const DISPLAY = 'Orbitron, Rajdhani, Bahnschrift, "Segoe UI", sans-serif';
const SANS = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';

/** Width an SVG string takes at a font size, close enough to lay chips out. */
const textWidth = (s: string, size: number): number => s.length * size * 0.58;

export interface DrawOptions {
  width: number;
  /** Prefix for element ids, so two drawings in one document never share a
   *  clip path. */
  uid: string;
  /** Where the drawing starts inside the SVG. */
  top?: number;
  onHover?: (m: MapSegment | null) => void;
  onPick?: (m: MapSegment) => void;
  /** The block being read, drawn with a focus ring. */
  activeIndex?: number | null;
}

/** The three rows, as SVG children. Returns the nodes and the height used. */
export const drawMeterMap = (d: MeterMapData, o: DrawOptions): { nodes: React.ReactNode; height: number } => {
  const W = o.width;
  const top = o.top ?? 0;
  const x = (t: number): number => (Math.min(Math.max(t, 0), d.duration) / d.duration) * W;
  const rulerY = top;
  const laneY = rulerY + ROWS.ruler + ROWS.gap;
  const syncY = laneY + ROWS.lane + ROWS.syncGap;
  const ticks = ticksFor(d.duration, W);
  const maxL = Math.max(0.25, ...d.bars.map((b) => b.lhl));

  const nodes = (
    <g key="map">
      {/* ruler */}
      <line x1={0} x2={W} y1={rulerY + ROWS.ruler - 0.5} y2={rulerY + ROWS.ruler - 0.5} stroke={LINE_STRONG} strokeWidth={1} />
      {ticks.map((t) => {
        const tx = x(t);
        const anchor = tx < 12 ? 'start' : tx > W - 12 ? 'end' : 'middle';
        return (
          <g key={`tick-${t}`}>
            <line x1={tx} x2={tx} y1={rulerY + ROWS.ruler - 5} y2={rulerY + ROWS.ruler} stroke={LINE_STRONG} strokeWidth={1} />
            <text x={tx} y={rulerY + ROWS.ruler - 8} fill={FAINT} fontFamily={SANS} fontSize={12} fontWeight={600} textAnchor={anchor}>
              {mmss(t)}
            </text>
          </g>
        );
      })}
      {d.tempo.slice(1).map((s, i) => {
        const tx = x(s.start_sec);
        const label = `${Math.round(s.bpm)}`;
        const flip = tx + 6 + textWidth(label, 12) > W;
        return (
          <g key={`flag-${i}`}>
            <title>{`${s.bpm} bpm from ${mmss(s.start_sec)}`}</title>
            <path d={`M ${tx - 5} ${rulerY + 4} L ${tx + 5} ${rulerY + 4} L ${tx} ${rulerY + 12} Z`} fill={TEMPO_COLOUR} />
            <text
              x={flip ? tx - 7 : tx + 7}
              y={rulerY + 12}
              fill={TEMPO_COLOUR}
              fontFamily={SANS}
              fontSize={12}
              fontWeight={700}
              textAnchor={flip ? 'end' : 'start'}
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* meter lane */}
      <rect x={0} y={laneY} width={W} height={ROWS.lane} rx={3} fill={LANE_BG} />
      {d.segments.map((m, i) => {
        const x0 = x(m.start_sec);
        const x1 = x(m.end_sec);
        const w = Math.max(0, x1 - x0);
        const colour = FAMILY_COLOUR[familyOf(numeratorOf(m))];
        const { sig, grp } = segmentLabel(m);
        const fit = labelFit(w);
        const mark = levelMark(m);
        const clipId = `${o.uid}-seg-${i}`;
        const words = describeSegment(m);
        const showGrp = fit === 'full' && !!grp && w > textWidth(sig, 16) + textWidth(grp, 12) + 24;
        const showMark = !!mark && fit !== 'none' && w > 60;
        const active = o.activeIndex === i;
        const interactive = !!(o.onHover || o.onPick);
        const cx = x0 + w / 2;
        return (
          <g
            key={`seg-${m.start_sec}-${i}`}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={words}
            onMouseEnter={o.onHover ? () => o.onHover?.(m) : undefined}
            onMouseLeave={o.onHover ? () => o.onHover?.(null) : undefined}
            onFocus={o.onHover ? () => o.onHover?.(m) : undefined}
            onBlur={o.onHover ? () => o.onHover?.(null) : undefined}
            onClick={o.onPick ? () => o.onPick?.(m) : undefined}
            onKeyDown={
              o.onPick
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      o.onPick?.(m);
                    }
                  }
                : undefined
            }
            style={interactive ? { cursor: 'pointer', outline: 'none' } : undefined}
          >
            <title>{words}</title>
            <clipPath id={clipId}>
              <rect x={x0} y={laneY} width={w} height={ROWS.lane} />
            </clipPath>
            {m.uncertain ? (
              <g clipPath={`url(#${clipId})`}>
                <rect x={x0} y={laneY} width={w} height={ROWS.lane} fill={colour} fillOpacity={0.18} />
                {Array.from({ length: Math.ceil((w + ROWS.lane) / 9) }, (_, k) => {
                  const sx = x0 - ROWS.lane + k * 9;
                  return (
                    <line
                      key={k}
                      x1={sx}
                      y1={laneY + ROWS.lane}
                      x2={sx + ROWS.lane}
                      y2={laneY}
                      stroke={colour}
                      strokeWidth={3.5}
                      strokeOpacity={0.75}
                    />
                  );
                })}
              </g>
            ) : (
              <rect x={x0} y={laneY} width={w} height={ROWS.lane} fill={colour} />
            )}
            <line x1={x1} x2={x1} y1={laneY} y2={laneY + ROWS.lane} stroke={INK} strokeWidth={1} />
            {fit !== 'none' && (
              <text
                x={cx}
                y={laneY + ROWS.lane / 2 + (showMark ? 2 : 6)}
                fill="#fff"
                fontFamily={DISPLAY}
                fontSize={16}
                fontWeight={700}
                textAnchor="middle"
                style={{ paintOrder: 'stroke', stroke: m.uncertain ? INK : 'rgba(0,0,0,0.45)', strokeWidth: m.uncertain ? 4 : 2 }}
              >
                {sig}
                {showGrp && (
                  <tspan fontSize={12} fontWeight={600} opacity={0.9} dx={6}>
                    {grp}
                  </tspan>
                )}
              </text>
            )}
            {showMark && (
              <text
                x={cx}
                y={laneY + ROWS.lane - 6}
                fill="#fff"
                fontFamily={SANS}
                fontSize={11}
                fontWeight={700}
                letterSpacing={1}
                textAnchor="middle"
                style={{ paintOrder: 'stroke', stroke: INK, strokeWidth: 3 }}
              >
                {mark}
              </text>
            )}
            {active && (
              <rect x={x0 + 1} y={laneY + 1} width={Math.max(0, w - 2)} height={ROWS.lane - 2} fill="none" stroke="#fff" strokeWidth={2} />
            )}
          </g>
        );
      })}

      {/* syncopation per bar */}
      <line x1={0} x2={W} y1={syncY + ROWS.sync - 0.5} y2={syncY + ROWS.sync - 0.5} stroke={LINE} strokeWidth={1} />
      <g>
        <title>{`Syncopation per bar, mean ${d.meanLhl.toFixed(2)}, peak ${d.maxLhl.toFixed(2)}`}</title>
        {d.bars.map((b, i) => {
          const v = b.lhl / maxL;
          if (v <= 0) return null;
          const bx0 = x(b.start_sec);
          const bx1 = x(b.end_sec);
          const h = v * (ROWS.sync - 3);
          return (
            <rect
              key={`bar-${i}`}
              x={bx0}
              width={Math.max(0.8, bx1 - bx0 - 0.6)}
              y={syncY + ROWS.sync - 1 - h}
              height={h}
              fill={SYNC_COLOUR}
              opacity={0.85}
            />
          );
        })}
      </g>
    </g>
  );
  return { nodes, height: chartHeight() };
};

/** The legend as SVG rows at a width. */
const drawLegend = (W: number, top: number): { nodes: React.ReactNode; height: number } => {
  const items: Array<{ swatch: React.ReactNode; words: string }> = LEGEND_ORDER.map((f) => ({
    swatch: <rect width={26} height={12} rx={2} fill={FAMILY_COLOUR[f]} />,
    words: FAMILY_WORDS[f],
  }));
  items.push({
    swatch: (
      <g>
        <rect width={26} height={12} rx={2} fill={FAMILY_COLOUR.m4} fillOpacity={0.18} />
        {[0, 6, 12, 18, 24].map((sx) => (
          <line key={sx} x1={sx - 4} y1={12} x2={sx + 8} y2={0} stroke={FAMILY_COLOUR.m4} strokeWidth={2.5} />
        ))}
      </g>
    ),
    words: 'guess (conf < 0.10)',
  });
  items.push({
    swatch: (
      <rect width={26} height={12} rx={2} fill={PANEL} stroke={LINE_STRONG}>
        <title>8TH</title>
      </rect>
    ),
    words: '8TH / 16TH: read at the tatum, not the tracked beat',
  });
  items.push({ swatch: <path d="M 8 1 L 18 1 L 13 10 Z" fill={TEMPO_COLOUR} />, words: 'tempo change' });
  items.push({
    swatch: <rect width={26} height={7} y={5} fill={SYNC_COLOUR} opacity={0.85} />,
    words: 'syncopation per bar',
  });
  const cols = W >= 900 ? 3 : W >= 560 ? 2 : 1;
  const colW = W / cols;
  const rowH = 22;
  const nodes = (
    <g key="legend">
      {items.map((it, i) => {
        const cx = (i % cols) * colW;
        const cy = top + Math.floor(i / cols) * rowH;
        return (
          <g key={i} transform={`translate(${cx} ${cy})`}>
            <g transform="translate(0 2)">{it.swatch}</g>
            <text x={34} y={12} fill={MUTED} fontFamily={SANS} fontSize={12} fontWeight={600}>
              {it.words}
            </text>
          </g>
        );
      })}
    </g>
  );
  return { nodes, height: Math.ceil(items.length / cols) * rowH };
};

/** The chips as SVG, wrapped to the width. */
const drawChips = (chips: Chip[], W: number, top: number): { nodes: React.ReactNode; height: number } => {
  const rowH = 26;
  let cx = 0;
  let row = 0;
  const placed = chips.map((c) => {
    const words = `${c.head}  ${c.tail}`;
    const w = textWidth(words, 12) + 18;
    if (cx + w > W && cx > 0) {
      cx = 0;
      row += 1;
    }
    const out = { c, x: cx, y: top + row * rowH, w };
    cx += w + 8;
    return out;
  });
  const nodes = (
    <g key="chips">
      {placed.map((p, i) => (
        <g key={i} transform={`translate(${p.x} ${p.y})`}>
          <rect width={p.w} height={20} rx={2} fill="none" stroke={CHIP_LINE[p.c.kind]} strokeWidth={1} />
          <text x={9} y={14} fontFamily={SANS} fontSize={12} fill={MUTED}>
            <tspan fill={TEXT} fontWeight={700}>
              {p.c.head}
            </tspan>
            <tspan dx={6}>{p.c.tail}</tspan>
          </text>
        </g>
      ))}
    </g>
  );
  return { nodes, height: chips.length ? (row + 1) * rowH : 0 };
};

export interface FramedOptions {
  title: string;
  tempoBpm: number | null;
  /** Key and scale from the ANALYSIS block, when known. */
  keyWords?: string | null;
  width?: number;
  analyzedAt?: number;
}

/** The whole picture for a file: title, facts, the drawing, chips, legend. */
export const meterMapSvgText = (d: MeterMapData, f: FramedOptions): { svg: string; width: number; height: number } => {
  const W = f.width ?? 1000;
  const PAD = 24;
  const inner = W - PAD * 2;
  const uid = 'mm-export';
  const facts = factsFor(d, f.tempoBpm);
  if (f.keyWords) facts.splice(2, 0, ['key', f.keyWords]);
  let y = PAD;
  const titleY = y + 22;
  y += 40;
  const factsY = y + 12;
  y += 30;
  const map = drawMeterMap(d, { width: inner, uid, top: y });
  y += map.height + 18;
  const chips = drawChips(chipsFor(d), inner, y);
  y += chips.height + (chips.height ? 12 : 0);
  const legend = drawLegend(inner, y);
  y += legend.height + 6;
  const stamp = f.analyzedAt ? new Date(f.analyzedAt * 1000).toLocaleDateString() : null;
  const footY = y + 12;
  y += 22;
  const H = y + PAD / 2;
  let fx = 0;
  const factNodes = facts.map(([k, v], i) => {
    const key = k.toUpperCase();
    const node = (
      <text key={i} x={PAD + fx} y={factsY} fontFamily={SANS} fontSize={12} fontWeight={600}>
        <tspan fill={FAINT} letterSpacing={1}>
          {key}
        </tspan>
        <tspan fill={TEXT} dx={8}>
          {v}
        </tspan>
      </text>
    );
    fx += textWidth(key, 12) * 1.08 + 8 + textWidth(v, 12) + 26;
    return node;
  });
  const svg = renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Meter map of ${f.title}`}>
      <rect width={W} height={H} fill={INK} />
      <rect x={PAD / 2} y={PAD / 2} width={W - PAD} height={H - PAD} rx={6} fill={PANEL} stroke={LINE} />
      <text x={PAD} y={titleY} fill={TEXT} fontFamily={DISPLAY} fontSize={22} fontWeight={700}>
        {f.title}
      </text>
      <text x={W - PAD} y={titleY} fill={FAMILY_COLOUR.m7} fontFamily={DISPLAY} fontSize={12} fontWeight={700} letterSpacing={2} textAnchor="end">
        METER MAP
      </text>
      {factNodes}
      <g transform={`translate(${PAD} 0)`}>
        {map.nodes}
        {chips.nodes}
        {legend.nodes}
      </g>
      <text x={PAD} y={footY} fill={FAINT} fontFamily={SANS} fontSize={11} fontWeight={600}>
        {`theDAW · rhythm module${stamp ? ` · analyzed ${stamp}` : ''} · bar length in tracked beats · times in mm:ss · confidence 0–1`}
      </text>
    </svg>,
  );
  return { svg, width: W, height: H };
};

/** The framed picture on a page of its own, with the numbers as a table
 *  under it so a reader can copy them. */
export const meterMapHtml = (d: MeterMapData, f: FramedOptions): string => {
  const { svg, width } = meterMapSvgText(d, f);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = d.segments
    .map(
      (m) =>
        `<tr><td>${mmss(m.start_sec)}</td><td>${mmss(m.end_sec)}</td><td>${esc(m.time_signature)}${m.uncertain ? ' <span class="guess">guess</span>' : ''}${levelMark(m) ? ` <span class="lvl">${levelMark(m)}</span>` : ''}</td><td>${m.bpm.toFixed(1)}</td><td>${m.bars}</td><td>${m.confidence.toFixed(2)}</td></tr>`,
    )
    .join('\n');
  const body = `${svg}
<table>
<thead><tr><th>From</th><th>To</th><th>Time signature</th><th>BPM</th><th>Bars</th><th>Confidence</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  const css = `
table { border-collapse: collapse; margin-top: 18px; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid ${LINE}; }
th { color: ${MUTED}; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; font-size: 11px; }
.guess { color: ${FAMILY_COLOUR.m5}; font-weight: 600; }
.lvl { color: ${MUTED}; font-weight: 700; font-size: 11px; letter-spacing: .1em; }`;
  return standaloneHtml({ title: `${f.title} — meter map`, body, css, background: INK, maxWidth: width });
};

/** The drawing on screen, measured to its box. */
export const MeterMapChart: React.FC<{
  data: MeterMapData;
  uid: string;
  /** Called with the block under the pointer or focus, null when none. */
  onDetail?: (m: MapSegment | null) => void;
  onPick?: (m: MapSegment) => void;
  activeIndex?: number | null;
}> = ({ data, uid, onDetail, onPick, activeIndex }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setWidth(host.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  const drawn = useMemo(
    () => (width > 0 ? drawMeterMap(data, { width, uid, onHover: onDetail, onPick, activeIndex }) : null),
    [data, width, uid, onDetail, onPick, activeIndex],
  );
  return (
    <div ref={hostRef} className="w-full min-w-0">
      {drawn && (
        <svg
          width={width}
          height={drawn.height}
          viewBox={`0 0 ${width} ${drawn.height}`}
          role="img"
          aria-label={`Meter map: ${data.segments.length} segments over ${mmss(data.duration)}`}
          style={{ display: 'block', overflow: 'visible' }}
        >
          {drawn.nodes}
        </svg>
      )}
    </div>
  );
};
