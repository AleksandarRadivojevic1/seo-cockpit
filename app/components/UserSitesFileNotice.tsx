/**
 * Shown when config/user-sites.json exists but can't be parsed. Without it a
 * malformed file reads exactly like "no dashboard-added sites": the pending
 * list goes quiet and nothing says why adding or removing is refused.
 */
export default function UserSitesFileNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/40 bg-card p-3 text-sm text-destructive"
    >
      {message}
    </p>
  );
}
