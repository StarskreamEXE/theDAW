/**
 * The meter map on screen, measured to its box, and its legend.
 *
 * The drawing itself lives in `meterMapDraw`, which this only sizes and hosts:
 * a module that exports a component beside plain functions cannot be
 * hot-reloaded, and the whole page reloads on every edit instead.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { mmss, type MapSegment, type MeterMapData } from '../../lib/meterMapLayout';
import { drawMeterMap, legendItems, SWATCH_H, SWATCH_W } from './meterMapDraw';

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

/** What the colours and marks mean, as rows that wrap to the block's width. */
export const MeterMapLegend: React.FC = () => {
  const items = useMemo(() => legendItems(), []);
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Meter map legend">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-2 text-xs font-bold text-zinc-400">
          <svg
            width={SWATCH_W}
            height={SWATCH_H}
            viewBox={`0 0 ${SWATCH_W} ${SWATCH_H}`}
            className="shrink-0"
            aria-hidden="true"
          >
            {it.swatch}
          </svg>
          {it.words}
        </li>
      ))}
    </ul>
  );
};
