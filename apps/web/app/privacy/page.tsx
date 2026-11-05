import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'What GenCut collects, why, who processes it, and how to have your data deleted.',
};

/** Where privacy and deletion requests go. */
const CONTACT = 'paul@gencut.ai';
const UPDATED = '5 November 2026';

function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <h2 className="display text-2xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * GenCut's privacy policy and data-deletion instructions (D-026). Public, no
 * sign-in. It states only what the product does today; update it with every
 * new kind of data or processor.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-10 px-5 py-12 leading-relaxed">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-bay-deep">GenCut</p>
        <h1 className="display text-4xl font-bold">Privacy policy</h1>
        <p className="text-ink-soft">Last updated {UPDATED}</p>
        <p>
          GenCut is a marketing assistant for real-estate agents. This page explains what information GenCut handles, why, who helps us process it, and how to
          have it deleted. Questions: <a className="font-semibold text-bay-deep underline underline-offset-4" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
        <p>
          <a className="font-semibold text-bay-deep underline underline-offset-4" href="#delete">
            How to delete your data →
          </a>
        </p>
      </header>

      <Section title="What we collect">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <strong>Agents who use GenCut:</strong> sign-in email; the business profile they enter (name, brokerage, license number, office address, market and
            ZIP codes, headshot); the letters, emails and campaigns they create and approve; and, if they link WhatsApp, their phone number and the messages
            they exchange with the GenCut assistant.
          </li>
          <li>
            <strong>Property owners and buyers in public records:</strong> owner names, mailing addresses, property details and recorded sales from the
            county property roll published by the State of Florida. GenCut uses them to suggest who an agent might write to.
          </li>
          <li>
            <strong>People who fill in an agent’s contact page:</strong> name, email, optional phone, what they are interested in, ZIP code, message, the
            consent wording they agreed to, and which site the visit came from. To limit abuse we keep a one-way, daily code derived from the visitor’s
            network address, never the address itself.
          </li>
          <li>
            <strong>Instagram:</strong> if an agent connects their own professional account, GenCut reads comments on that account’s recent posts that contain
            the agent’s keywords (the commenter’s username, the comment and its time) so the agent can choose to reply with their contact-page link.
          </li>
          <li>
            <strong>Email recipients:</strong> the address an agent sends to, the message, whether it was sent, and unsubscribe requests.
          </li>
        </ul>
      </Section>

      <Section title="How we use it">
        <p>
          Only to run GenCut for the agent: finding and ranking opportunities, drafting letters, emails and posts for the agent to review, answering the agent
          on WhatsApp, showing the agent who asked to be contacted, and keeping a record of what was approved and sent. Nothing is sent to anyone without the
          agent’s approval. We do not sell personal information, and we do not use it for advertising.
        </p>
      </Section>

      <Section title="Who processes it for us">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>Supabase: database and sign-in</li>
          <li>Netlify: website hosting</li>
          <li>Anthropic: AI that drafts letters and understands WhatsApp messages (the text needed for that task only)</li>
          <li>Resend: sending approved emails</li>
          <li>Meta: WhatsApp messages and, when connected, Instagram comments and replies</li>
        </ul>
        <p>Each processes information only to provide its service to GenCut.</p>
      </Section>

      <Section title="How long we keep it">
        <p>
          While the agent’s account is active, and then until it is deleted. Unsubscribe requests are kept so we never email that address again. Public-record
          data is refreshed from the county roll and removed when it is no longer published.
        </p>
      </Section>

      <Section id="delete" title="How to delete your data">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <strong>Anyone:</strong> email <a className="font-semibold text-bay-deep underline underline-offset-4" href={`mailto:${CONTACT}?subject=Delete%20my%20data`}>{CONTACT}</a>{' '}
            with the subject “Delete my data” and the email address, phone number or Instagram username GenCut may hold. We confirm and delete within 30 days,
            except what the law requires us to keep, and except the record that you asked not to be contacted.
          </li>
          <li>
            <strong>WhatsApp:</strong> send <strong>STOP</strong> to the GenCut number to unlink your phone at once, then email us to delete the conversation.
          </li>
          <li>
            <strong>Email:</strong> every email sent through GenCut has an unsubscribe link that works without signing in.
          </li>
          <li>
            <strong>Agents:</strong> email us from your sign-in address to close your account and delete its data.
          </li>
        </ul>
      </Section>

      <footer className="border-t border-glass-deep pt-6 text-sm text-ink-soft">
        GenCut · <a className="underline underline-offset-4" href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </footer>
    </main>
  );
}
