import { currentHeadshotId, getBusinessProfile, getWhatsAppLink, whatsappConfigFromEnv } from '@gencut/services';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';
import { HeadshotForm } from '../_profile-form/headshot-form.tsx';
import { ProfileForm } from '../_profile-form/profile-form.tsx';
import { WhatsAppLink } from '../_profile-form/whatsapp-link.tsx';
import { profileToFormValues } from '../_profile-form/values.ts';

export const metadata: Metadata = { title: 'Business profile' };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { ctx, workspace } = await requireSession();
  const profile = await getBusinessProfile(db(), ctx, workspace.workspaceId);
  if (!profile) redirect('/onboarding');
  const { saved } = await searchParams;
  const [headshotId, whatsapp] = await Promise.all([currentHeadshotId(db(), ctx, workspace.workspaceId), getWhatsAppLink(db(), ctx)]);
  const whatsappConfig = whatsappConfigFromEnv(process.env);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="display text-4xl font-bold">Business profile</h1>
      {saved && (
        <p className="mt-4 rounded-xl bg-glass p-4 text-sm" role="status">
          Profile saved.
        </p>
      )}
      <div className="mt-8">
        <HeadshotForm headshotId={headshotId} name={profile.licenseeName} />
      </div>
      {whatsappConfig && (
        <div className="mt-8">
          <WhatsAppLink linkedNumber={whatsapp.number} businessNumber={whatsappConfig.displayNumber} />
        </div>
      )}
      <div className="mt-10">
        <ProfileForm initial={profileToFormValues(profile)} submitLabel="Save changes" next="/profile?saved=1" />
      </div>
    </div>
  );
}
