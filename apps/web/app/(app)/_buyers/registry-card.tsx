import { filingTypeLabel, officerName, officerTitleLabel } from '@gencut/core';
import type { CompanyRegistryEntry } from '@gencut/services';
import { formatDay } from '../../../lib/discovery-copy.ts';

const SUNBIZ_SEARCH = 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByDocumentNumber';

const line = (a: { address1: string; address2: string; city: string; state: string; zip: string }) =>
  [a.address1, a.address2, [a.city, a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

/**
 * Who is behind a buying company, from the Florida company register (D-028):
 * the people and companies on file as its officers or managers, its registered
 * agent and its business addresses. A record on file, not a confirmed contact.
 */
export function RegistryCard({ entry, rollName }: { entry: CompanyRegistryEntry | null; rollName: string }) {
  if (!entry) {
    return (
      <section aria-labelledby="registry" className="rounded-panel border border-glass-deep p-6">
        <h2 id="registry" className="display text-xl font-semibold">
          Who&rsquo;s behind it
        </h2>
        <p className="mt-2 text-ink-soft">
          No record in the Florida company register matches &ldquo;{rollName}&rdquo; exactly. It may be registered under a different spelling, in
          another state, or not yet in the quarterly file. Search the name on{' '}
          <a href="https://search.sunbiz.org/Inquiry/CorporationSearch/ByName" target="_blank" rel="noopener noreferrer" className="font-medium text-bay-deep underline underline-offset-4">
            Sunbiz
          </a>
          .
        </p>
      </section>
    );
  }
  const r = entry.record;
  const people = r.officers.filter((o) => o.type !== 'company');
  const companies = r.officers.filter((o) => o.type === 'company');
  const principal = line(r.principal);
  const mailing = line(r.mailing);
  return (
    <section aria-labelledby="registry" className="rounded-panel border border-glass-deep p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="registry" className="display text-xl font-semibold">
          Who&rsquo;s behind it
        </h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${r.status === 'active' ? 'bg-glass text-bay-deep' : 'bg-[#f1f1ef] text-ink-soft'}`}>
          {r.status === 'active' ? 'Active in Florida' : 'Inactive in Florida'}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {r.name} · {filingTypeLabel(r.filingType)}
        {r.filedOn ? ` · filed ${formatDay(r.filedOn)}` : ''}
        {r.reportYears.length ? ` · annual reports ${[...r.reportYears].sort((a, b) => a - b).join(', ')}` : ''}
      </p>
      {entry.match === 'shortened' && (
        <p className="mt-3 rounded-xl bg-glass p-3 text-sm" role="note">
          Matched on a shortened name: the county roll keeps 30 characters (&ldquo;{rollName}&rdquo;), and this is the only active Florida company whose
          name starts with it. Check the document number before you rely on it.
        </p>
      )}

      <h3 className="mt-5 text-sm font-semibold uppercase tracking-wide text-ink-soft">On file as officers or managers</h3>
      {people.length || companies.length ? (
        <ul className="mt-2 grid gap-2">
          {people.map((o) => (
            <li key={`${o.title}-${o.name}`} className="flex flex-wrap items-baseline justify-between gap-x-4 rounded-xl bg-glass/60 px-4 py-2.5">
              <span className="font-semibold">{officerName(o.name).display}</span>
              <span className="text-sm text-ink-soft">{officerTitleLabel(o.title)}</span>
            </li>
          ))}
          {companies.map((o) => (
            <li key={`${o.title}-${o.name}`} className="flex flex-wrap items-baseline justify-between gap-x-4 rounded-xl border border-glass px-4 py-2.5">
              <span>
                <span className="font-medium">{o.name}</span>
                <span className="block text-xs text-ink-soft">A company holds this role: the person behind it is in that company&rsquo;s own record</span>
              </span>
              <span className="text-sm text-ink-soft">{officerTitleLabel(o.title)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-ink-soft">The record lists no officers or managers.</p>
      )}
      {r.moreOfficers && <p className="mt-2 text-sm text-ink-soft">The record has more than six officers; the register file lists six. Sunbiz shows all.</p>}

      <dl className="mt-5 grid gap-2 text-[0.95rem]">
        {r.registeredAgent && (
          <div className="grid grid-cols-[minmax(8rem,40%)_1fr] gap-3">
            <dt className="text-sm text-ink-soft">Registered agent</dt>
            <dd>
              {r.registeredAgent.name}
              {r.registeredAgent.type === 'company' ? <span className="text-ink-soft"> (a service company)</span> : null}
            </dd>
          </div>
        )}
        {principal && (
          <div className="grid grid-cols-[minmax(8rem,40%)_1fr] gap-3">
            <dt className="text-sm text-ink-soft">Business address</dt>
            <dd>{principal}</dd>
          </div>
        )}
        {mailing && mailing !== principal && (
          <div className="grid grid-cols-[minmax(8rem,40%)_1fr] gap-3">
            <dt className="text-sm text-ink-soft">Mailing address</dt>
            <dd>{mailing}</dd>
          </div>
        )}
        <div className="grid grid-cols-[minmax(8rem,40%)_1fr] gap-3">
          <dt className="text-sm text-ink-soft">Florida document number</dt>
          <dd className="font-mono text-sm tabular-nums">{r.documentNumber}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-ink-soft">
        From the Florida Division of Corporations register of {formatDay(entry.fileDate)}. People on file are the company&rsquo;s officers or managers
        as filed, not confirmation of who decides on purchases. Check it on{' '}
        <a href={SUNBIZ_SEARCH} target="_blank" rel="noopener noreferrer" className="font-medium text-bay-deep underline underline-offset-4">
          Sunbiz
        </a>{' '}
        with the document number.
      </p>
    </section>
  );
}
