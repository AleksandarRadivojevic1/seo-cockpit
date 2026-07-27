import { buildTrendPaths } from "../../lib/report/chart";
import { formatIntSr } from "../../lib/report/format";
import type { TrendPointSr } from "../../lib/report/data";

const W = 640;
const H = 150;
const PAD_L = 34;
const PAD_B = 18;

/**
 * The client report's impressions line.
 *
 * A server component by design: no "use client", no hooks, no observers,
 * no animation. The whole SVG is in the initial HTML, so the browser's
 * print snapshot cannot catch it unmounted, mid-animation, or sized to the
 * screen rather than the page — the three failure modes that ruled out
 * reusing the dashboard's visx chart here.
 *
 * Colours are literals rather than theme variables: this element is printed,
 * and the print stylesheet forces a light page regardless of the reader's
 * OS colour scheme.
 */
export default function ReportChart({ points }: { points: TrendPointSr[] }) {
  const { segments, max, ticks } = buildTrendPaths(points, W - PAD_L, H - PAD_B);
  if (segments.length === 0) return null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full"
      role="img"
      aria-label="Prikazi kroz vreme"
    >
      <g transform={`translate(${PAD_L},0)`}>
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W - PAD_L}
            y1={(H - PAD_B) * f}
            y2={(H - PAD_B) * f}
            stroke="#e3e6ec"
            strokeWidth={1}
          />
        ))}
        {segments.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="#1b4f8f"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </g>
      <text x={0} y={10} fontSize={10} fill="#8990a0">
        {formatIntSr(max)}
      </text>
      <text x={0} y={H - PAD_B} fontSize={10} fill="#8990a0">
        0
      </text>
      {ticks.map((t) => (
        <text
          key={t.label}
          x={PAD_L + t.x}
          y={H - 4}
          fontSize={10}
          fill="#8990a0"
          textAnchor={t.x === 0 ? "start" : "end"}
        >
          {t.label}
        </text>
      ))}
    </svg>
  );
}
