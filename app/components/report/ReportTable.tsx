/**
 * The report's one table shape.
 *
 * A plain server-rendered table with no sorting, no truncation and no
 * horizontal scroll: on paper none of those exist, and a column that only
 * works on screen is a column the client never sees.
 */
export default function ReportTable({
  head,
  rows,
  numeric = [],
}: {
  head: string[];
  rows: (string | number)[][];
  numeric?: boolean[];
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th
              key={h || `col-${i}`}
              className={`border-b border-neutral-200 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-neutral-400 ${
                numeric[i] ? "text-right" : "text-left"
              }`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[0])}>
            {row.map((cell, i) => (
              <td
                key={i}
                className={`border-b border-neutral-100 py-1.5 ${
                  numeric[i] ? "text-right tabular-nums" : "text-left"
                }`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
