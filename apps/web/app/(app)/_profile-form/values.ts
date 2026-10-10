import type { BusinessProfile } from '@gencut/services';
import type { ProfileFormValues } from './actions.ts';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function profileToFormValues(p: BusinessProfile | null): ProfileFormValues {
  return {
    licenseeName: p?.licenseeName ?? '',
    brokerageName: p?.brokerageName ?? '',
    licenseNumber: p?.licenseNumber ?? '',
    officeAddress: p?.officeAddress ?? '',
    market: p?.market ?? 'miami-dade',
    specialty: p?.specialty ?? '',
    focusZips: p?.focusZips.join(' ') ?? '',
    propertyUses: p ? [...p.propertyUses] : [],
    minValue: p?.minValue != null ? usd.format(p.minValue) : '',
    maxValue: p?.maxValue != null ? usd.format(p.maxValue) : '',
  };
}

export function formatPriceBand(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${usd.format(min)} to ${usd.format(max)}`;
  return min != null ? `From ${usd.format(min)}` : `Up to ${usd.format(max as number)}`;
}
