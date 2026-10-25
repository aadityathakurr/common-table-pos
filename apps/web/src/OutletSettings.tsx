import { useState } from 'react';
import type { FormEvent } from 'react';
import { Check, LoaderCircle, Save, Settings2 } from 'lucide-react';
import { supabase } from './supabase';

type Outlet = {
  tenant_id: string;
  outlet_id: string;
  name: string;
  timezone: string;
  currency: string;
  tax_rate_bps: number;
};

type OutletUpdate = Pick<Outlet, 'name' | 'timezone' | 'currency' | 'tax_rate_bps'>;

type Props = {
  outlet: Outlet;
  canEdit: boolean;
  onSaved: (outlet: Outlet) => void;
};

const fieldClass = 'h-11 w-full rounded-xl border border-[#dfe6df] bg-white px-3 text-sm text-[#263b30] outline-none transition focus:border-[#4a8a61] focus:ring-4 focus:ring-[#4a8a61]/10 disabled:bg-[#f6f8f6] disabled:text-[#7e8c82]';

function initialDraft(outlet: Outlet): OutletUpdate {
  return {
    name: outlet.name,
    timezone: outlet.timezone,
    currency: outlet.currency.trim().toUpperCase(),
    tax_rate_bps: outlet.tax_rate_bps,
  };
}

function validate(draft: OutletUpdate): string | null {
  if (!draft.name.trim() || draft.name.trim().length > 120) return 'Enter an outlet name from 1 to 120 characters.';
  if (!/^[A-Z]{3}$/.test(draft.currency.trim().toUpperCase())) return 'Currency must be a three-letter ISO code, such as INR.';
  if (!Number.isInteger(draft.tax_rate_bps) || draft.tax_rate_bps < 0 || draft.tax_rate_bps > 10_000) return 'Tax rate must be from 0% to 100%.';
  try { new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone.trim() }); }
  catch { return 'Enter a valid IANA timezone, such as Asia/Kolkata.'; }
  return null;
}

export default function OutletSettings({ outlet, canEdit, onSaved }: Props) {
  const [draft, setDraft] = useState<OutletUpdate>(() => initialDraft(outlet));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !canEdit) return;
    const normalized: OutletUpdate = {
      name: draft.name.trim(),
      timezone: draft.timezone.trim(),
      currency: draft.currency.trim().toUpperCase(),
      tax_rate_bps: draft.tax_rate_bps,
    };
    const validationError = validate(normalized);
    if (validationError) { setError(validationError); setNotice(''); return; }

    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { data, error: updateError } = await supabase.from('outlets')
        .update(normalized)
        .eq('tenant_id', outlet.tenant_id)
        .eq('outlet_id', outlet.outlet_id)
        .select('tenant_id,outlet_id,name,timezone,currency,tax_rate_bps')
        .maybeSingle();
      if (updateError) throw updateError;
      if (!data) throw new Error('No outlet was updated. Check your outlet manager access and try again.');
      const updated = data as Outlet;
      onSaved(updated);
      setDraft(initialDraft(updated));
      setNotice('Outlet settings saved. Paired edges will apply them on their next cloud sync.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save outlet settings. Please retry.');
    } finally {
      setSaving(false);
    }
  }

  const changed = draft.name !== outlet.name || draft.timezone !== outlet.timezone
    || draft.currency.trim().toUpperCase() !== outlet.currency.trim().toUpperCase()
    || draft.tax_rate_bps !== outlet.tax_rate_bps;

  return <section className="rounded-2xl border border-[#e1e8e1] bg-white p-6" aria-labelledby="outlet-settings-title">
    <div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl bg-[#edf3f7] text-[#587c98]"><Settings2 size={18}/></span>
      <div><h2 id="outlet-settings-title" className="font-bold">Outlet settings</h2><p className="text-xs text-[#839087]">Name, timezone, currency, and configured tax rate.</p></div>
    </div>
    <form className="mt-5 space-y-3" onSubmit={save}>
      <label className="block text-xs font-semibold text-[#536259]">Outlet name
        <input className={`${fieldClass} mt-1.5`} value={draft.name} maxLength={120} required disabled={!canEdit || saving} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}/>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs font-semibold text-[#536259]">Timezone
          <input className={`${fieldClass} mt-1.5`} value={draft.timezone} maxLength={80} required disabled={!canEdit || saving} onChange={event => setDraft(current => ({ ...current, timezone: event.target.value }))}/>
        </label>
        <label className="block text-xs font-semibold text-[#536259]">Currency
          <input className={`${fieldClass} mt-1.5 uppercase`} value={draft.currency} maxLength={3} required disabled={!canEdit || saving} onChange={event => setDraft(current => ({ ...current, currency: event.target.value.toUpperCase() }))}/>
        </label>
      </div>
      <label className="block text-xs font-semibold text-[#536259]">Tax rate (basis points)
        <input className={`${fieldClass} mt-1.5`} type="number" min={0} max={10000} step={1} value={draft.tax_rate_bps} required disabled={!canEdit || saving} onChange={event => setDraft(current => ({ ...current, tax_rate_bps: Number(event.target.value) }))}/>
        <small className="mt-1 block font-normal text-[#89958d]">{(draft.tax_rate_bps / 100).toFixed(2)}%. Confirm the applicable tax treatment with your accountant.</small>
      </label>
      {error&&<p role="alert" className="rounded-lg bg-[#fff2ef] px-3 py-2 text-xs text-[#a34d3d]">{error}</p>}
      {notice&&<p role="status" className="rounded-lg bg-[#f0f7f0] px-3 py-2 text-xs text-[#39704d]">{notice}</p>}
      {canEdit&&<button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#286a4f] px-4 text-sm font-semibold text-white transition hover:bg-[#1f563f] disabled:cursor-not-allowed disabled:opacity-55" disabled={saving || !changed}>
        {saving?<LoaderCircle className="animate-spin" size={15}/>:notice?<Check size={15}/>:<Save size={15}/>}Save settings
      </button>}
      {!canEdit&&<p className="text-xs text-[#87938b]">Only an owner or outlet manager can change these settings.</p>}
    </form>
  </section>;
}
