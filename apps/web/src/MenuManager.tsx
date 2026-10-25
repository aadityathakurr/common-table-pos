import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Archive, LoaderCircle, Pencil, Plus, RefreshCw, Save, Sparkles, X } from 'lucide-react';
import { DEMO_MENU, type ModifierOption } from '@common-table/contracts';
import { supabase } from './supabase';

interface MenuCategoryRow {
  category_id: string;
  name: string;
  sort_order: number;
  active: boolean;
}

interface MenuItemRow {
  item_id: string;
  category_id: string;
  name: string;
  price_minor: number;
  emoji: string;
  color: string;
  tag: string | null;
  vegetarian: boolean;
  available: boolean;
  kitchen_station: string;
  modifiers: ModifierOption[];
  sort_order: number;
}

interface Props { tenantId: string; outletId: string; currency?: string; }
interface Draft {
  itemId: string;
  name: string;
  categoryId: string;
  price: string;
  emoji: string;
  kitchenStation: string;
  vegetarian: boolean;
}

const fieldClass = 'h-10 w-full rounded-xl border border-[#dfe6df] bg-white px-3 text-sm text-[#263b30] outline-none focus:border-[#4a8a61]';
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#286a4f] px-3.5 text-sm font-semibold text-white transition hover:bg-[#1f563f] disabled:cursor-not-allowed disabled:opacity-55';
const emptyDraft: Draft = { itemId: '', name: '', categoryId: '', price: '', emoji: '🍽️', kitchenStation: 'Main kitchen', vegetarian: true };

export default function MenuManager({ tenantId, outletId, currency='INR' }: Props) {
  const [categories, setCategories] = useState<MenuCategoryRow[]>([]);
  const [items, setItems] = useState<MenuItemRow[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [newCategory, setNewCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const categoryName = useMemo(() => new Map(categories.map(row => [row.category_id, row.name])), [categories]);
  const formatPrice = useCallback((minor:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency}).format(minor/100),[currency]);

  const load = useCallback(async () => {
    if (!supabase) return;
    setBusy(true); setError('');
    try {
      const [categoryResult, itemResult] = await Promise.all([
        supabase.from('menu_categories').select('category_id,name,sort_order,active').eq('tenant_id', tenantId).eq('outlet_id', outletId).order('sort_order').order('name'),
        supabase.from('menu_items').select('item_id,category_id,name,price_minor,emoji,color,tag,vegetarian,available,kitchen_station,modifiers,sort_order').eq('tenant_id', tenantId).eq('outlet_id', outletId).order('sort_order').order('name'),
      ]);
      if (categoryResult.error) throw categoryResult.error;
      if (itemResult.error) throw itemResult.error;
      const loadedCategories = (categoryResult.data ?? []) as MenuCategoryRow[];
      setCategories(loadedCategories);
      setItems((itemResult.data ?? []) as MenuItemRow[]);
      setDraft(current => ({ ...current, categoryId: loadedCategories.some(row => row.category_id === current.categoryId) ? current.categoryId : loadedCategories[0]?.category_id ?? '' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the cloud menu.');
    } finally { setBusy(false); }
  }, [tenantId, outletId]);

  useEffect(() => { void load(); }, [load]);

  async function publishTrainingMenu() {
    if (!supabase) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const names = [...new Set(DEMO_MENU.map(item => item.category))];
      const categoryUpsert = await supabase.from('menu_categories').upsert(
        names.map((name, sort_order) => ({ tenant_id: tenantId, outlet_id: outletId, name, sort_order, active: true })),
        { onConflict: 'tenant_id,outlet_id,name' },
      );
      if (categoryUpsert.error) throw categoryUpsert.error;
      const categoryResult = await supabase.from('menu_categories').select('category_id,name').eq('tenant_id', tenantId).eq('outlet_id', outletId);
      if (categoryResult.error) throw categoryResult.error;
      const ids = new Map((categoryResult.data ?? []).map(row => [row.name as string, row.category_id as string]));
      const rows = DEMO_MENU.map((item, sort_order) => ({
        tenant_id: tenantId, outlet_id: outletId, item_id: item.id,
        category_id: ids.get(item.category), name: item.name, price_minor: item.priceMinor,
        emoji: item.emoji, color: item.color, tag: item.tag ?? null, vegetarian: item.vegetarian,
        available: item.available, kitchen_station: item.kitchenStation, modifiers: item.modifiers, sort_order,
      }));
      if (rows.some(row => !row.category_id)) throw new Error('A demo menu category could not be resolved. Retry publishing.');
      const itemResult = await supabase.from('menu_items').upsert(rows, { onConflict: 'tenant_id,outlet_id,item_id' });
      if (itemResult.error) throw itemResult.error;
      setNotice(`Published ${rows.length} training items in ${names.length} categories to this outlet.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not publish the training menu.');
    } finally { setBusy(false); }
  }

  async function addCategory(event: FormEvent) {
    event.preventDefault(); if (!supabase || !newCategory.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await supabase.from('menu_categories').insert({ tenant_id: tenantId, outlet_id: outletId, name: newCategory.trim(), sort_order: categories.length }).select('category_id').single();
      if (result.error) throw result.error;
      const id = result.data.category_id as string;
      setNewCategory(''); await load(); setDraft(current => ({ ...current, categoryId: id }));
      setNotice('Menu category added.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add the category.'); }
    finally { setBusy(false); }
  }

  async function saveItem(event: FormEvent) {
    event.preventDefault(); if (!supabase || !draft.categoryId) return;
    const price = Number(draft.price);
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000) { setError('Enter a valid item price in rupees.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const existing = items.find(item => item.item_id === draft.itemId);
      const result = await supabase.from('menu_items').upsert({
        tenant_id: tenantId, outlet_id: outletId,
        item_id: existing?.item_id ?? crypto.randomUUID(), category_id: draft.categoryId,
        name: draft.name.trim(), price_minor: Math.round(price * 100),
        emoji: draft.emoji.trim() || '🍽️', color: existing?.color ?? '#f3f4f6',
        tag: existing?.tag ?? null, vegetarian: draft.vegetarian, available: existing?.available ?? true,
        kitchen_station: draft.kitchenStation.trim() || 'Main kitchen',
        modifiers: existing?.modifiers ?? [], sort_order: existing?.sort_order ?? items.length,
      }, { onConflict: 'tenant_id,outlet_id,item_id' });
      if (result.error) throw result.error;
      setDraft({ ...emptyDraft, categoryId: draft.categoryId });
      setNotice(existing ? 'Menu item updated.' : 'Menu item added.'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the menu item.'); }
    finally { setBusy(false); }
  }

  function editItem(item: MenuItemRow) {
    setDraft({ itemId: item.item_id, name: item.name, categoryId: item.category_id, price: (Number(item.price_minor) / 100).toFixed(2), emoji: item.emoji, kitchenStation: item.kitchen_station, vegetarian: item.vegetarian });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function setAvailability(item: MenuItemRow) {
    if (!supabase) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await supabase.from('menu_items').update({ available: !item.available, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('outlet_id', outletId).eq('item_id', item.item_id);
      if (result.error) throw result.error;
      setNotice(`${item.name} ${item.available ? 'marked unavailable' : 'made available'}.`); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update availability.'); }
    finally { setBusy(false); }
  }

  return <section className="rounded-2xl border border-[#e1e8e1] bg-white p-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#79887f]">Cloud menu</p><h2 className="mt-1 text-xl font-bold">Manage this outlet’s menu</h2><p className="mt-1 max-w-2xl text-sm leading-5 text-[#718077]">Menu categories, prices, availability, and kitchen routing are stored in Supabase for this outlet.</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#dfe7df] px-3 text-sm font-semibold text-[#397451] hover:bg-[#f6f9f6] disabled:opacity-50" disabled={busy} onClick={() => void load()}><RefreshCw size={15}/>Refresh</button><button type="button" className={buttonClass} disabled={busy} onClick={() => void publishTrainingMenu()}>{busy?<LoaderCircle className="animate-spin" size={15}/>:<Sparkles size={15}/>}Publish training menu</button></div>
    </div>
    {error&&<div role="alert" className="mt-4 rounded-xl border border-[#f1c8c0] bg-[#fff4f1] px-4 py-3 text-sm text-[#9a493d]">{error}</div>}
    {notice&&<div role="status" className="mt-4 rounded-xl border border-[#cfe3d2] bg-[#f0f8f1] px-4 py-3 text-sm text-[#356d49]">{notice}</div>}
    <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(280px,.8fr)_minmax(420px,1.2fr)]">
      <div className="space-y-4">
        <form onSubmit={addCategory} className="rounded-xl border border-[#e8ede8] bg-[#fbfcfb] p-4"><h3 className="text-sm font-bold">Add category</h3><div className="mt-3 flex gap-2"><input aria-label="New category name" className={fieldClass} maxLength={80} required placeholder="e.g. Seasonal specials" value={newCategory} onChange={event => setNewCategory(event.target.value)}/><button className={buttonClass} disabled={busy||!newCategory.trim()} aria-label="Add category"><Plus size={16}/></button></div></form>
        <form onSubmit={saveItem} className="rounded-xl border border-[#e8ede8] bg-[#fbfcfb] p-4"><div className="flex items-center justify-between"><h3 className="text-sm font-bold">{draft.itemId?'Edit menu item':'Add menu item'}</h3>{draft.itemId&&<button type="button" aria-label="Cancel item edit" className="grid size-8 place-items-center rounded-lg text-[#839087] hover:bg-[#eef2ee]" onClick={() => setDraft({ ...emptyDraft, categoryId: draft.categoryId })}><X size={15}/></button>}</div><div className="mt-3 space-y-3"><label className="block text-xs font-semibold text-[#536259]">Item name<input className={`${fieldClass} mt-1.5`} maxLength={120} required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label><div className="grid grid-cols-2 gap-3"><label className="block text-xs font-semibold text-[#536259]">Category<select className={`${fieldClass} mt-1.5`} required value={draft.categoryId} onChange={event => setDraft({ ...draft, categoryId: event.target.value })}><option value="" disabled>Select</option>{categories.filter(row=>row.active).map(row=><option key={row.category_id} value={row.category_id}>{row.name}</option>)}</select></label><label className="block text-xs font-semibold text-[#536259]">Price ({currency})<input className={`${fieldClass} mt-1.5`} type="number" inputMode="decimal" min="0" max="1000000" step="0.01" required value={draft.price} onChange={event => setDraft({ ...draft, price: event.target.value })}/></label></div><div className="grid grid-cols-[72px_1fr] gap-3"><label className="block text-xs font-semibold text-[#536259]">Icon<input className={`${fieldClass} mt-1.5`} maxLength={8} value={draft.emoji} onChange={event => setDraft({ ...draft, emoji: event.target.value })}/></label><label className="block text-xs font-semibold text-[#536259]">Kitchen station<input className={`${fieldClass} mt-1.5`} maxLength={80} required value={draft.kitchenStation} onChange={event => setDraft({ ...draft, kitchenStation: event.target.value })}/></label></div><label className="flex items-center gap-2 text-sm text-[#536259]"><input type="checkbox" checked={draft.vegetarian} onChange={event => setDraft({ ...draft, vegetarian: event.target.checked })}/>Vegetarian</label><button className={buttonClass} disabled={busy||!draft.categoryId}>{busy?<LoaderCircle className="animate-spin" size={15}/>:<Save size={15}/>}Save item</button></div></form>
      </div>
      <div className="min-w-0"><div className="mb-3 flex items-center justify-between text-sm"><strong>Published items</strong><span className="text-xs text-[#839087]">{items.length} items · {categories.length} categories</span></div>{busy&&!items.length?<div className="grid min-h-48 place-items-center text-[#6f8b78]"><LoaderCircle className="animate-spin"/></div>:items.length?<div className="max-h-[640px] overflow-auto rounded-xl border border-[#e8ede8]"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-[#f6f8f6] text-xs text-[#758179]"><tr><th className="px-3 py-2.5 font-semibold">Item</th><th className="px-3 py-2.5 font-semibold">Price</th><th className="px-3 py-2.5 font-semibold">Status</th><th className="px-3 py-2.5"></th></tr></thead><tbody>{items.map(item=><tr key={item.item_id} className="border-t border-[#edf0ed]"><td className="px-3 py-2.5"><strong className="block text-xs">{item.emoji} {item.name}</strong><small className="text-[11px] text-[#8a968f]">{categoryName.get(item.category_id)??'Category'} · {item.kitchen_station}</small></td><td className="whitespace-nowrap px-3 py-2.5 text-xs">{formatPrice(Number(item.price_minor))}</td><td className="px-3 py-2.5"><button type="button" onClick={() => void setAvailability(item)} disabled={busy} className={`inline-flex items-center gap-1 text-[11px] font-semibold ${item.available?'text-[#397451]':'text-[#9a6b40]'}`}>{item.available?'Available':'Unavailable'}{item.available?<Archive size={12}/>:<Plus size={12}/>}</button></td><td className="px-3 py-2.5"><button type="button" aria-label={`Edit ${item.name}`} title={`Edit ${item.name}`} onClick={() => editItem(item)} className="grid size-8 place-items-center rounded-lg border border-[#e5ebe5] text-[#5f7567] hover:bg-[#f5f8f5]"><Pencil size={13}/></button></td></tr>)}</tbody></table></div>:<div className="grid min-h-48 place-items-center rounded-xl border border-dashed border-[#dfe8e1] bg-[#fbfcfb] px-5 text-center"><div><p className="text-sm font-semibold text-[#607168]">No cloud menu yet</p><p className="mt-1 text-xs text-[#91a096]">Publish the fictional training catalogue or add your own categories and items.</p></div></div>}</div>
    </div>
    <p className="mt-4 text-xs leading-5 text-[#8a968f]">Menu changes are stored in Supabase. A paired outlet edge refreshes the menu into SQLite and keeps serving its last synced copy during a WAN outage. Cloud is the menu source of truth; offline menu editing is not available.</p>
  </section>;
}
