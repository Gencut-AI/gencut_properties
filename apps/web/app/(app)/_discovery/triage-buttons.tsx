import type { OpportunityStatus } from '@gencut/services';
import { triageAction } from './actions.ts';

const button =
  'min-h-11 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-offset-2 disabled:opacity-50';

/** Save / Dismiss, or Restore, as plain forms: they work before JavaScript loads. */
export function TriageButtons({ id, status, compact = false }: { id: string; status: OpportunityStatus; compact?: boolean }) {
  if (status === 'in_campaign') return <p className="text-sm text-ink-soft">In a campaign</p>;
  const choices: { to: string; label: string; primary?: boolean }[] =
    status === 'new'
      ? [
          { to: 'saved', label: 'Save', primary: true },
          { to: 'dismissed', label: 'Dismiss' },
        ]
      : status === 'saved'
        ? [
            { to: 'new', label: 'Unsave' },
            { to: 'dismissed', label: 'Dismiss' },
          ]
        : [{ to: 'new', label: 'Restore', primary: true }];
  return (
    <div className={`flex gap-2 ${compact ? '' : 'flex-wrap'}`}>
      {choices.map((c) => (
        <form key={c.to} action={triageAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value={c.to} />
          <button
            type="submit"
            className={
              c.primary
                ? `${button} bg-bay text-paper hover:bg-bay-deep`
                : `${button} border border-glass-deep text-ink hover:border-ink-soft`
            }
          >
            {c.label}
          </button>
        </form>
      ))}
    </div>
  );
}
