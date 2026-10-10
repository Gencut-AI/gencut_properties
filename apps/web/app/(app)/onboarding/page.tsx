import { getBusinessProfile } from '@gencut/services';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';
import { ProfileForm } from '../_profile-form/profile-form.tsx';
import { profileToFormValues } from '../_profile-form/values.ts';

export const metadata: Metadata = { title: 'Set up your business' };

export default async function OnboardingPage() {
  const { ctx, workspace } = await requireSession();
  if (await getBusinessProfile(db(), ctx, workspace.workspaceId)) redirect('/home');

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="display text-4xl font-bold">Tell GenCut about your business</h1>
      <p className="mt-3 max-w-[56ch] text-ink-soft">
        This is how GenCut knows where to look for opportunities and how to sign the campaigns it makes. It takes about two minutes.
      </p>
      <div className="mt-10">
        <ProfileForm initial={profileToFormValues(null)} submitLabel="Save and continue" next="/home" />
      </div>
    </div>
  );
}
