'use server';

import { isServiceError, saveBusinessProfile } from '@gencut/services';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { safeNextPath } from '../../../lib/safe-redirect.ts';
import { requireSession } from '../../../lib/session.ts';

export interface ProfileFormValues {
  licenseeName: string;
  brokerageName: string;
  licenseNumber: string;
  officeAddress: string;
  market: string;
  specialty: string;
  focusZips: string;
  propertyUses: string[];
  minValue: string;
  maxValue: string;
  includeLargeBuildings: boolean;
}

export type ProfileFormState =
  | { status: 'idle' }
  | { status: 'error'; message: string; fields: Record<string, string>; values: ProfileFormValues };

function money(v: string): number | undefined {
  const digits = v.replace(/[^\d]/g, '');
  return digits ? Number(digits) : undefined;
}

export async function saveProfileAction(_prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const { ctx, workspace } = await requireSession();
  const text = (k: string) => String(form.get(k) ?? '').trim();
  const values: ProfileFormValues = {
    licenseeName: text('licenseeName'),
    brokerageName: text('brokerageName'),
    licenseNumber: text('licenseNumber'),
    officeAddress: text('officeAddress'),
    market: text('market'),
    specialty: text('specialty'),
    focusZips: text('focusZips'),
    propertyUses: form.getAll('propertyUses').map(String),
    minValue: text('minValue'),
    maxValue: text('maxValue'),
    includeLargeBuildings: form.get('includeLargeBuildings') === '1',
  };

  try {
    await saveBusinessProfile(db(), ctx, workspace.workspaceId, {
      licenseeName: values.licenseeName,
      brokerageName: values.brokerageName,
      licenseNumber: values.licenseNumber || undefined,
      officeAddress: values.officeAddress || undefined,
      market: values.market,
      specialty: values.specialty || undefined,
      focusZips: values.focusZips.split(/[\s,;]+/).filter(Boolean),
      propertyUses: values.propertyUses,
      minValue: money(values.minValue),
      maxValue: money(values.maxValue),
      includeLargeBuildings: values.includeLargeBuildings,
    });
  } catch (e) {
    if (isServiceError(e)) return { status: 'error', message: e.message, fields: { ...e.fields }, values };
    throw e;
  }
  redirect(safeNextPath(text('next'), '/home'));
}
