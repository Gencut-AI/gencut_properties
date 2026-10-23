import type { CampaignMediaView } from '@gencut/services';
import Link from 'next/link';
import { AutoRefresh } from '../_discovery/auto-refresh.tsx';
import { startMediaAction } from './actions.ts';

const usd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

interface Agent {
  readonly name: string;
  readonly brokerage: string;
}

function StartButton({ campaignId, label, restart = false }: { campaignId: string; label: string; restart?: boolean }) {
  return (
    <form action={startMediaAction} className="mt-4">
      <input type="hidden" name="campaignId" value={campaignId} />
      {restart && <input type="hidden" name="restart" value="1" />}
      <button type="submit" className="h-11 rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep">
        {label}
      </button>
    </form>
  );
}

function Step({ label, state }: { label: string; state: 'done' | 'working' | 'waiting' }) {
  return (
    <li className="flex items-center gap-3">
      {state === 'done' && <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full bg-bay text-xs text-paper">✓</span>}
      {state === 'working' && <span aria-hidden="true" className="rec-dot size-2.5 rounded-full bg-flamingo" />}
      {state === 'waiting' && <span aria-hidden="true" className="size-2.5 rounded-full border border-ink-soft" />}
      <span className={state === 'waiting' ? 'text-ink-soft' : ''}>
        {label} <span className="sr-only">({state})</span>
      </span>
    </li>
  );
}

/** The agent's avatar: their uploaded headshot, or their initials until they add one. */
function Avatar({ headshotId, name }: { headshotId: string | null; name: string }) {
  if (headshotId) return <img src={`/media/${headshotId}`} alt="" className="size-10 rounded-full object-cover" />;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-glass text-sm font-semibold text-bay-deep">
      {initials}
    </span>
  );
}

/**
 * The Film Crew's work on a campaign: a social post about the agent and the
 * area, with an illustrative neighborhood picture. Nothing here is posted.
 */
export function FilmCrew({
  campaignId,
  media,
  agent,
  enabled,
  startError,
}: {
  campaignId: string;
  media: CampaignMediaView;
  agent: Agent;
  enabled: boolean;
  startError: string | null;
}) {
  // A run that has not reported back for three minutes most likely never started.
  const since = media.startedAt?.getTime() ?? null;
  const stuck = media.status === 'generating' && (since === null || Date.now() - since > 3 * 60_000);
  const left = Math.max(0, media.budgetUsd - media.costUsd);
  const post = media.socialPost;

  return (
    <section id="film-crew" aria-labelledby="film-crew-title" className="scroll-mt-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="film-crew-title" className="display text-xl font-semibold">
          Film Crew
        </h2>
        {media.status === 'ready' && <span className="text-sm text-ink-soft">Draft · not posted</span>}
      </div>

      {startError && (
        <p role="alert" className="mt-3 rounded-xl border border-[#e7b3c0] bg-[#fdf4f6] p-3 text-sm">
          {startError}
        </p>
      )}

      {media.status === 'none' && (
        <div className="mt-3 rounded-panel bg-glass p-6">
          <p>
            A social post introducing you to homeowners in this area, with a picture of the neighborhood. It never names this property or its
            owner. The picture is generated and labelled as illustrative.
          </p>
          {!media.headshotId && (
            <p className="mt-3 text-sm">
              Add your photo in{' '}
              <Link href="/profile" className="font-medium text-bay-deep underline underline-offset-4">
                Profile
              </Link>{' '}
              so the post shows you. You can do it before or after.
            </p>
          )}
          {enabled ? (
            <>
              <StartButton campaignId={campaignId} label="Create the social post" />
              <p className="mt-2 text-xs text-ink-soft">About {usd(0.05)} per run · media budget {usd(media.budgetUsd)} per campaign</p>
            </>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">The Film Crew is not set up on this site yet (an image service key is missing).</p>
          )}
        </div>
      )}

      {media.status === 'generating' && (
        <div aria-live="polite" className="mt-3 rounded-panel border border-glass-deep p-6">
          {!stuck && <AutoRefresh seconds={5} />}
          {stuck ? (
            <>
              <p className="font-medium">The Film Crew has not reported back.</p>
              <p className="mt-1 text-ink-soft">You can start it again; finished steps are not charged twice.</p>
              <StartButton campaignId={campaignId} label="Start again" restart />
            </>
          ) : (
            <ol className="grid gap-3">
              <Step label="Copywriter · social post" state={post ? 'done' : 'working'} />
              <Step label="Photographer · neighborhood picture" state={post ? 'working' : 'waiting'} />
            </ol>
          )}
        </div>
      )}

      {media.status === 'failed' && (
        <div className="mt-3 rounded-panel border border-[#e7b3c0] bg-[#fdf4f6] p-6">
          <p className="font-medium">{media.problems.length > 0 ? 'The post did not pass GenCut’s checks' : 'The media could not be made'}</p>
          <p className="mt-1 text-ink-soft">{media.error}</p>
          {media.problems.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {media.problems.map((p) => (
                <li key={p.message}>{p.message}</li>
              ))}
            </ul>
          )}
          {enabled && <StartButton campaignId={campaignId} label="Try again" />}
        </div>
      )}

      {media.status === 'ready' && post && (
        <>
          <article aria-label="Social post preview" className="mx-auto mt-4 max-w-md overflow-hidden rounded-panel border border-glass-deep bg-white shadow-sm">
            <header className="flex items-center gap-3 p-4">
              <Avatar headshotId={media.headshotId} name={agent.name} />
              <div className="leading-tight">
                <p className="font-semibold">{agent.name}</p>
                <p className="text-xs text-ink-soft">{agent.brokerage}</p>
              </div>
            </header>
            {media.neighborhoodImageId && (
              <figure className="relative">
                <img src={`/media/${media.neighborhoodImageId}`} alt="Illustrative picture of the neighborhood, generated by AI" className="aspect-[4/5] w-full object-cover" />
                <figcaption className="absolute bottom-3 left-3 rounded-full bg-ink/75 px-3 py-1 text-xs font-medium text-paper">Illustrative image</figcaption>
              </figure>
            )}
            <div className="p-4">
              <p className="display text-lg font-semibold">{post.headline}</p>
              <p className="mt-2 whitespace-pre-line text-[0.95rem]">{post.caption}</p>
              <p className="mt-2 text-[0.95rem] font-medium">{post.callToAction}</p>
              <p className="mt-2 text-sm text-bay-deep">{post.hashtags.join(' ')}</p>
            </div>
          </article>
          {!media.headshotId && (
            <p className="mt-3 text-center text-sm">
              <Link href="/profile" className="font-medium text-bay-deep underline underline-offset-4">
                Add your photo
              </Link>{' '}
              to show it on the post.
            </p>
          )}
          {enabled && left >= 0.06 && (
            <div className="text-center">
              <StartButton campaignId={campaignId} label="Make another version" />
            </div>
          )}
        </>
      )}

      {media.calls > 0 && (
        <p className="mt-3 text-xs text-ink-soft">
          Film Crew · {media.calls} call{media.calls === 1 ? '' : 's'}
          {media.failedCalls ? ` (${media.failedCalls} failed)` : ''} · {usd(media.costUsd)} of {usd(media.budgetUsd)} media budget
        </p>
      )}
    </section>
  );
}
