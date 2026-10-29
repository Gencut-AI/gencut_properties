'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { approveAndSendAction, type EmailFormState, enableEmailAction, prepareEmailAction } from './email-actions.ts';

export interface EmailPanelProps {
  campaignId: string;
  audience: 'owner' | 'company';
  configured: boolean;
  mode: 'off' | 'test_only' | 'live';
  permitted: boolean;
  missing: readonly string[];
  defaultSubject: string;
  sentTo: readonly string[];
  action: {
    id: string;
    state: 'DRAFT' | 'READY' | 'APPROVED' | 'EXECUTING' | 'COMPLETED' | 'FAILED';
    to: string;
    subject: string;
    text: string;
    fromName: string;
    stale: boolean;
    sentAt: string | null;
    failureReason: string | null;
  } | null;
}

const input =
  'h-12 w-full rounded-xl border border-glass-deep bg-white px-4 text-[0.95rem] outline-none focus:border-bay aria-[invalid=true]:border-[#b42345]';
const primary = 'h-11 rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep disabled:opacity-60';
const secondary = 'h-11 rounded-full border border-glass-deep px-5 text-sm font-medium hover:bg-glass disabled:opacity-60';
const idle: EmailFormState = { status: 'idle' };

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

function ErrorNote({ state }: { state: EmailFormState }) {
  if (state.status !== 'error') return null;
  return (
    <p role="alert" className="rounded-xl bg-[#fdebef] p-3 text-sm text-[#7d1a33]">
      {state.message}
    </p>
  );
}

/** Send the campaign letter by email: turn on the channel, prepare, approve, send. */
export function EmailSend(p: EmailPanelProps) {
  const a = p.action;
  const sending = a?.state === 'APPROVED' || a?.state === 'EXECUTING';
  const sent = a?.state === 'COMPLETED';
  const ready = a?.state === 'READY' && !a.stale;
  const who = p.audience === 'company' ? 'the company' : 'the owner';

  return (
    <section id="email" aria-labelledby="email-title" className="rounded-panel border border-glass-deep p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="email-title" className="display text-xl font-semibold">
          Send by email
        </h2>
        {p.mode === 'test_only' && (
          <span className="rounded-full bg-glass px-3 py-1 text-xs font-medium text-bay-deep">Test mode · team inboxes only</span>
        )}
      </div>
      <p className="mt-2 text-ink-soft">
        GenCut emails this letter to {who} from your name, with your office address, an advertisement notice and an unsubscribe link. Replies go
        straight to your inbox. Nothing is sent until you approve the exact message.
      </p>

      {!p.configured ? (
        <p className="mt-4 text-sm text-ink-soft">Email sending is not set up on this site yet.</p>
      ) : !p.permitted ? (
        <EnableEmail campaignId={p.campaignId} />
      ) : p.missing.length > 0 ? (
        <p className="mt-4 rounded-xl bg-glass px-4 py-3 text-sm">
          Every email must include {p.missing.join(', ')}.{' '}
          <Link href="/profile" className="font-medium text-bay-deep underline underline-offset-4">
            Add {p.missing.length > 1 ? 'them' : 'it'} in Profile
          </Link>
          , then come back here.
        </p>
      ) : (
        <div className="mt-5 grid gap-5">
          {sent && a && (
            <div role="status" className="rounded-xl border border-[#9fd3b8] bg-[#f1fbf5] p-4">
              <p className="font-medium">Sent to {a.to}</p>
              <p className="mt-1 text-sm text-ink-soft">
                {a.sentAt ? `${when(a.sentAt)} · ` : ''}Accepted by the email service. Replies arrive in your inbox; record what happens under Outcome.
              </p>
            </div>
          )}
          {sending && (
            <p role="status" className="rounded-xl bg-glass p-4 text-sm">
              Sending to {a?.to}…
            </p>
          )}
          {a?.state === 'FAILED' && (
            <div role="alert" className="rounded-xl border border-[#e7b3c0] bg-[#fdf4f6] p-4">
              <p className="font-medium">Not sent to {a.to}</p>
              <p className="mt-1 text-sm">{a.failureReason}</p>
              <p className="mt-1 text-sm text-ink-soft">Fix the problem and prepare the email again.</p>
            </div>
          )}

          {ready && a ? (
            <Approve campaignId={p.campaignId} action={a} />
          ) : (
            !sending && (
              <Prepare
                campaignId={p.campaignId}
                defaultTo={a && !sent ? a.to : ''}
                defaultSubject={a && !sent ? a.subject : p.defaultSubject}
                stale={Boolean(a?.stale && a.state === 'READY')}
                again={sent}
              />
            )
          )}
        </div>
      )}
    </section>
  );
}

function EnableEmail({ campaignId }: { campaignId: string }) {
  const [state, action, pending] = useActionState(enableEmailAction, idle);
  return (
    <form action={action} className="mt-4 grid gap-3 rounded-xl bg-glass p-4">
      <input type="hidden" name="campaignId" value={campaignId} />
      <p className="text-sm">
        <span className="font-medium">Email outreach is off for your account.</span> Finding opportunities and writing letters never contacts anyone;
        sending email is a separate permission you turn on once. You still approve every message.
      </p>
      <ErrorNote state={state} />
      <div>
        <button type="submit" disabled={pending} className={primary}>
          {pending ? 'Turning on…' : 'Turn on email outreach'}
        </button>
      </div>
    </form>
  );
}

function Prepare(props: { campaignId: string; defaultTo: string; defaultSubject: string; stale: boolean; again: boolean }) {
  const [state, action, pending] = useActionState(prepareEmailAction, idle);
  const err = state.status === 'error' ? state.fields : {};
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="campaignId" value={props.campaignId} />
      {props.stale && <p className="rounded-xl bg-glass p-3 text-sm">You edited the letter after preparing this email. Prepare it again to approve the new version.</p>}
      {props.again && <p className="text-sm font-medium">Send to someone else</p>}
      <label className="grid gap-1 text-sm font-medium">
        Recipient email
        <input
          name="to"
          type="email"
          required
          autoComplete="off"
          defaultValue={props.defaultTo}
          placeholder="name@example.com"
          className={input}
          aria-invalid={Boolean(err.to)}
          aria-describedby={err.to ? 'to-error' : undefined}
        />
        {err.to && (
          <span id="to-error" className="font-normal text-[#7d1a33]">
            {err.to}
          </span>
        )}
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Subject
        <input name="subject" required maxLength={120} defaultValue={props.defaultSubject} className={input} aria-invalid={Boolean(err.subject)} />
        {err.subject && <span className="font-normal text-[#7d1a33]">{err.subject}</span>}
      </label>
      {!err.to && !err.subject && <ErrorNote state={state} />}
      <div>
        <button type="submit" disabled={pending} className={primary}>
          {pending ? 'Preparing…' : 'Preview the email'}
        </button>
      </div>
    </form>
  );
}

function Approve({ campaignId, action: a }: { campaignId: string; action: NonNullable<EmailPanelProps['action']> }) {
  const [state, action, pending] = useActionState(approveAndSendAction, idle);
  const [prepState, prepAction, prepPending] = useActionState(prepareEmailAction, idle);
  return (
    <div className="grid gap-4">
      <div className="overflow-hidden rounded-panel border border-glass-deep bg-white shadow-sm">
        <dl className="grid gap-1 border-b border-glass-deep bg-glass px-5 py-3 text-sm">
          <div className="flex gap-2">
            <dt className="w-16 text-ink-soft">From</dt>
            <dd>{a.fromName}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 text-ink-soft">To</dt>
            <dd className="break-all">{a.to}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 text-ink-soft">Subject</dt>
            <dd className="font-medium">{a.subject}</dd>
          </div>
        </dl>
        <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap px-5 py-4 font-[Georgia,serif] text-[0.98rem] leading-relaxed">{a.text}</pre>
      </div>
      <form action={action} className="grid gap-3">
        <input type="hidden" name="campaignId" value={campaignId} />
        <input type="hidden" name="actionId" value={a.id} />
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" name="confirm" value="yes" required className="mt-1 size-5 accent-[var(--color-bay)]" />
          <span>
            I approve sending this exact email to <span className="font-medium break-all">{a.to}</span>.
          </span>
        </label>
        <ErrorNote state={state} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={pending} className={primary}>
            {pending ? 'Sending…' : 'Approve and send'}
          </button>
        </div>
      </form>
      <form action={prepAction}>
        <input type="hidden" name="campaignId" value={campaignId} />
        <details className="text-sm" open={prepState.status === 'error'}>
          <summary className="min-h-11 cursor-pointer content-center text-ink-soft">Change the recipient or subject</summary>
          <EditFields to={a.to} subject={a.subject} pending={prepPending} />
          <div className="mt-3">
            <ErrorNote state={prepState} />
          </div>
        </details>
      </form>
    </div>
  );
}

function EditFields({ to, subject, pending }: { to: string; subject: string; pending: boolean }) {
  return (
    <div className="mt-3 grid gap-3">
      <input name="to" type="email" required defaultValue={to} className={input} aria-label="Recipient email" />
      <input name="subject" required maxLength={120} defaultValue={subject} className={input} aria-label="Subject" />
      <div>
        <button type="submit" disabled={pending} className={secondary}>
          {pending ? 'Preparing…' : 'Update the preview'}
        </button>
      </div>
    </div>
  );
}
