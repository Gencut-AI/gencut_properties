'use client';

import { useActionState } from 'react';
import { type ProfileFormState, type ProfileFormValues, saveProfileAction } from './actions.ts';

const MARKETS = [
  { key: 'miami-dade', label: 'Miami-Dade County' },
  { key: 'broward', label: 'Broward County' },
  { key: 'palm-beach', label: 'Palm Beach County' },
];

const PROPERTY_TYPES = [
  { key: 'single_family', label: 'Single-family homes' },
  { key: 'condo', label: 'Condos' },
  { key: 'townhouse', label: 'Townhouses' },
  { key: 'multifamily', label: 'Multifamily' },
  { key: 'vacant_land', label: 'Land' },
];

const fieldClass =
  'h-12 w-full rounded-xl border border-glass-deep bg-white px-4 text-base outline-none focus:border-bay aria-[invalid=true]:border-[#b42345]';

function Field(props: {
  name: keyof ProfileFormValues;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.name} className="text-sm font-medium">
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <p id={`${props.name}-error`} className="text-sm text-[#b42345]">
          {props.error}
        </p>
      ) : props.hint ? (
        <p className="text-sm text-ink-soft">{props.hint}</p>
      ) : null}
    </div>
  );
}

export function ProfileForm({
  initial,
  submitLabel,
  next,
}: {
  initial: ProfileFormValues;
  submitLabel: string;
  next: string;
}) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(saveProfileAction, { status: 'idle' });
  const v = state.status === 'error' ? state.values : initial;
  const err = state.status === 'error' ? state.fields : {};
  const aria = (k: keyof ProfileFormValues) => ({
    'aria-invalid': Boolean(err[k]),
    'aria-describedby': err[k] ? `${k}-error` : undefined,
  });

  return (
    <form action={action} className="flex flex-col gap-8 pb-28 sm:pb-0" noValidate>
      <input type="hidden" name="next" value={next} />
      {state.status === 'error' && (
        <p className="rounded-xl bg-[#fde7ec] p-4 text-sm text-[#7d1830]" role="alert">
          {state.message}
        </p>
      )}

      <fieldset className="flex flex-col gap-5">
        <legend className="display mb-4 text-xl font-semibold">You and your brokerage</legend>
        <Field name="licenseeName" label="Your name as licensed" error={err.licenseeName}>
          <input id="licenseeName" name="licenseeName" autoComplete="name" defaultValue={v.licenseeName} className={fieldClass} {...aria('licenseeName')} />
        </Field>
        <Field
          name="brokerageName"
          label="Brokerage name"
          hint="Exactly as registered with the state. Florida requires it on every ad, so GenCut adds it to everything it makes."
          error={err.brokerageName}
        >
          <input id="brokerageName" name="brokerageName" autoComplete="organization" defaultValue={v.brokerageName} className={fieldClass} {...aria('brokerageName')} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field name="licenseNumber" label="License number (optional)" error={err.licenseNumber}>
            <input id="licenseNumber" name="licenseNumber" autoCapitalize="characters" defaultValue={v.licenseNumber} className={fieldClass} {...aria('licenseNumber')} />
          </Field>
          <Field name="specialty" label="Specialty (optional)" hint="For example: waterfront condos." error={err.specialty}>
            <input id="specialty" name="specialty" defaultValue={v.specialty} className={fieldClass} {...aria('specialty')} />
          </Field>
        </div>
        <Field
          name="officeAddress"
          label="Office address (optional)"
          hint="Marketing emails must show a postal address. You can add it later."
          error={err.officeAddress}
        >
          <input id="officeAddress" name="officeAddress" autoComplete="street-address" defaultValue={v.officeAddress} className={fieldClass} {...aria('officeAddress')} />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-5">
        <legend className="display mb-4 text-xl font-semibold">Where and what you sell</legend>
        <Field name="market" label="Market" error={err.market}>
          <select id="market" name="market" defaultValue={v.market || 'miami-dade'} className={fieldClass} {...aria('market')}>
            {MARKETS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field name="focusZips" label="ZIP codes you work" hint="Separate with spaces or commas, for example 33139 33140." error={err.focusZips}>
          <input id="focusZips" name="focusZips" inputMode="numeric" defaultValue={v.focusZips} className={fieldClass} {...aria('focusZips')} />
        </Field>
        <div className="flex flex-col gap-2" role="group" aria-labelledby="propertyUses-label" aria-describedby={err.propertyUses ? 'propertyUses-error' : undefined}>
          <span id="propertyUses-label" className="text-sm font-medium">
            Property types
          </span>
          <div className="flex flex-wrap gap-2">
            {PROPERTY_TYPES.map((t) => (
              <label
                key={t.key}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-glass-deep bg-white px-4 has-[:checked]:border-bay has-[:checked]:bg-glass has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-bay"
              >
                <input type="checkbox" name="propertyUses" value={t.key} defaultChecked={v.propertyUses.includes(t.key)} className="size-4 accent-[#0f6e73]" />
                {t.label}
              </label>
            ))}
          </div>
          {err.propertyUses && (
            <p id="propertyUses-error" className="text-sm text-[#b42345]">
              {err.propertyUses}
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field name="minValue" label="Price from (optional)" error={err.minValue}>
            <input id="minValue" name="minValue" inputMode="numeric" placeholder="$500,000" defaultValue={v.minValue} className={fieldClass} {...aria('minValue')} />
          </Field>
          <Field name="maxValue" label="Price to (optional)" error={err.maxValue}>
            <input id="maxValue" name="maxValue" inputMode="numeric" placeholder="$5,000,000" defaultValue={v.maxValue} className={fieldClass} {...aria('maxValue')} />
          </Field>
        </div>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-[0.95rem]">
          <input type="checkbox" name="includeLargeBuildings" value="1" defaultChecked={v.includeLargeBuildings} className="mt-1 size-4 accent-[#0f6e73]" />
          <span>
            Include buildings of 10 or more units
            <span className="block text-sm text-ink-soft">Off by default: whole apartment buildings are rarely residential listings.</span>
          </span>
        </label>
      </fieldset>

      <div className="fixed inset-x-0 bottom-0 border-t border-glass-deep bg-paper/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
        <button
          type="submit"
          disabled={pending}
          className="h-14 w-full rounded-xl bg-bay text-lg font-semibold text-paper transition-colors hover:bg-bay-deep disabled:opacity-60 sm:w-auto sm:px-8"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
