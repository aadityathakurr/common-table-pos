import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Archive, PackagePlus, RefreshCw, Scale } from 'lucide-react';
import { supabase } from './supabase';

type Unit = 'each'|'g'|'kg'|'ml'|'l'|'portion'|'pack';
type MovementType = 'receipt'|'waste'|'count_adjustment';
interface InventoryItem {
  inventory_item_id: string;
  name: string;
  sku: string|null;
  unit: Unit;
  reorder_level: number;
  active: boolean;
  on_hand: number;
  low_stock: boolean;
}
interface InventoryMovement {
  movement_id: string;
  inventory_item_id: string;
  movement_type: MovementType;
  request_quantity: number;
  expected_balance: number|null;
  quantity_delta: number;
  reason: string;
  occurred_at: string;
}
interface Props { tenantId: string; outletId: string; userId: string; }

const units: Unit[] = ['each','g','kg','ml','l','portion','pack'];
const inputClass = 'h-10 w-full rounded-xl border border-[#dfe6df] bg-white px-3 text-sm text-[#263b30] outline-none focus:border-[#4a8a61]';
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#286a4f] px-3.5 text-sm font-semibold text-white transition hover:bg-[#1f563f] disabled:cursor-not-allowed disabled:opacity-55';
const movementName: Record<MovementType,string> = { receipt:'Received', waste:'Waste', count_adjustment:'Stock count' };
const quantity = (value:number) => Number(value).toLocaleString('en-IN',{maximumFractionDigits:3});

export default function InventoryManager({tenantId,outletId,userId}:Props) {
  const [items,setItems] = useState<InventoryItem[]>([]);
  const [movements,setMovements] = useState<InventoryMovement[]>([]);
  const [itemDraft,setItemDraft] = useState({name:'',sku:'',unit:'each' as Unit,reorderLevel:'0'});
  const [movementDraft,setMovementDraft] = useState({itemId:'',type:'receipt' as MovementType,quantity:'',reason:''});
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const movementCommandId = useRef<string|null>(null);
  const movementCommandPayload = useRef<string|null>(null);
  const itemById = useMemo(()=>new Map(items.map(item=>[item.inventory_item_id,item])),[items]);

  const load = useCallback(async()=>{
    if(!supabase)return;
    setBusy(true);setError('');
    try {
      const [itemResult,movementResult] = await Promise.all([
        supabase.from('inventory_stock_balances').select('inventory_item_id,name,sku,unit,reorder_level,active,on_hand,low_stock')
          .eq('tenant_id',tenantId).eq('outlet_id',outletId).order('name'),
        supabase.from('inventory_movements').select('movement_id,inventory_item_id,movement_type,request_quantity,expected_balance,quantity_delta,reason,occurred_at')
          .eq('tenant_id',tenantId).eq('outlet_id',outletId).order('occurred_at',{ascending:false}).order('movement_id',{ascending:false}).limit(50),
      ]);
      if(itemResult.error)throw itemResult.error;
      if(movementResult.error)throw movementResult.error;
      const nextItems=((itemResult.data??[]) as InventoryItem[]).map(item=>({...item,
        reorder_level:Number(item.reorder_level),on_hand:Number(item.on_hand),active:Boolean(item.active),low_stock:Boolean(item.low_stock)}));
      const nextMovements=((movementResult.data??[]) as InventoryMovement[]).map(movement=>({...movement,
        request_quantity:Number(movement.request_quantity),expected_balance:movement.expected_balance===null?null:Number(movement.expected_balance),
        quantity_delta:Number(movement.quantity_delta)}));
      setItems(nextItems);setMovements(nextMovements);
      setMovementDraft(current=>({...current,itemId:nextItems.some(item=>item.inventory_item_id===current.itemId)?current.itemId:nextItems.find(item=>item.active)?.inventory_item_id??''}));
    } catch(cause) { setError(cause instanceof Error?cause.message:'Could not load outlet inventory.'); }
    finally { setBusy(false); }
  },[tenantId,outletId]);

  useEffect(()=>{void load();},[load]);

  async function addItem(event:FormEvent) {
    event.preventDefault();if(!supabase)return;
    const name=itemDraft.name.trim();const reorder=Number(itemDraft.reorderLevel);
    if(!name||name.length>120||!Number.isFinite(reorder)||reorder<0||reorder>1_000_000_000||Math.round(reorder*1000)!==reorder*1000){setError('Enter an item name and a non-negative reorder level with up to three decimal places.');return;}
    setBusy(true);setError('');setNotice('');
    try {
      const {error:insertError}=await supabase.from('inventory_items').insert({
        tenant_id:tenantId,outlet_id:outletId,name,sku:itemDraft.sku.trim()||null,unit:itemDraft.unit,
        reorder_level:reorder,created_by:userId,
      });
      if(insertError)throw insertError;
      setItemDraft({name:'',sku:'',unit:'each',reorderLevel:'0'});setNotice(`${name} added to outlet inventory.`);await load();
    } catch(cause) { setError(cause instanceof Error?cause.message:'Could not add inventory item.'); }
    finally { setBusy(false); }
  }

  async function recordMovement(event:FormEvent) {
    event.preventDefault();if(!supabase)return;
    const item=itemById.get(movementDraft.itemId);const amount=Number(movementDraft.quantity);const reason=movementDraft.reason.trim();
    if(!item||!item.active){setError('Choose an active inventory item.');return;}
    if(!Number.isFinite(amount)||amount<0||amount>1_000_000_000||Math.round(amount*1000)!==amount*1000
      ||(movementDraft.type!=='count_adjustment'&&amount<=0)){setError('Enter a valid quantity, up to three decimal places.');return;}
    if(reason.length<3||reason.length>120){setError('Enter a reason between 3 and 120 characters.');return;}
    const expectedBalance=movementDraft.type==='count_adjustment'?item.on_hand:null;
    const payload=JSON.stringify([item.inventory_item_id,movementDraft.type,amount,reason,expectedBalance]);
    if(movementCommandId.current&&movementCommandPayload.current!==payload){setError('The previous movement may already have been saved. Refresh inventory before changing its details.');return;}
    setBusy(true);setError('');setNotice('');
    try {
      if(!movementCommandId.current){movementCommandId.current=crypto.randomUUID();movementCommandPayload.current=payload;}
      const {error:recordError}=await supabase.rpc('record_inventory_movement',{
        p_tenant_id:tenantId,p_outlet_id:outletId,p_inventory_item_id:item.inventory_item_id,
        p_command_id:movementCommandId.current,p_movement_type:movementDraft.type,p_quantity:amount,p_reason:reason,
        p_expected_balance:expectedBalance,
      });
      if(recordError)throw recordError;
      movementCommandId.current=null;movementCommandPayload.current=null;
      setMovementDraft(current=>({...current,quantity:'',reason:''}));
      setNotice(movementDraft.type==='count_adjustment'&&Math.round(amount*1000)===Math.round(item.on_hand*1000)
        ?'Stock count recorded; there was no variance.'
        :`${movementName[movementDraft.type]} movement recorded for ${item.name}.`);
      await load();
    } catch(cause) { setError(cause instanceof Error?cause.message:'Could not record stock movement. Refresh and try again.'); }
    finally { setBusy(false); }
  }

  async function setItemActive(item:InventoryItem) {
    if(!supabase)return;
    setBusy(true);setError('');setNotice('');
    try {
      const {error:updateError}=await supabase.from('inventory_items').update({active:!item.active,updated_at:new Date().toISOString()})
        .eq('tenant_id',tenantId).eq('outlet_id',outletId).eq('inventory_item_id',item.inventory_item_id);
      if(updateError)throw updateError;
      setNotice(`${item.name} ${item.active?'archived':'restored'}.`);await load();
    } catch(cause) { setError(cause instanceof Error?cause.message:'Could not update inventory item.'); }
    finally { setBusy(false); }
  }

  return <section className="mt-5 rounded-2xl border border-[#e1e8e1] bg-white p-6" aria-labelledby="inventory-heading">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#829087]">Outlet stock</p><h2 id="inventory-heading" className="mt-1 text-lg font-bold">Inventory</h2>
        <p className="mt-1 text-xs text-[#839087]">Cloud stock ledger · receipts, waste, and physical counts</p></div>
      <button type="button" className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-[#dfe7df] px-3 text-xs font-semibold text-[#456c54] disabled:opacity-50" onClick={()=>void load()} disabled={busy}><RefreshCw size={14} className={busy?'animate-spin':''}/>Refresh</button>
    </div>
    {error&&<div role="alert" className="mt-4 rounded-xl border border-[#f1c8c0] bg-[#fff4f1] px-4 py-3 text-xs text-[#9a493d]">{error}</div>}
    {notice&&<div role="status" className="mt-4 rounded-xl border border-[#cfe3d2] bg-[#f0f8f1] px-4 py-3 text-xs text-[#356d49]">{notice}</div>}

    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      <form onSubmit={addItem} className="rounded-xl border border-[#e6ebe6] bg-[#fbfcfb] p-4">
        <div className="flex items-center gap-2"><PackagePlus size={16} className="text-[#43805b]"/><h3 className="text-sm font-semibold">Add stock item</h3></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium">Ingredient or supply<input className={`${inputClass} mt-1`} required maxLength={120} value={itemDraft.name} onChange={e=>setItemDraft({...itemDraft,name:e.target.value})} placeholder="Paneer"/></label>
          <label className="text-xs font-medium">SKU (optional)<input className={`${inputClass} mt-1`} maxLength={80} value={itemDraft.sku} onChange={e=>setItemDraft({...itemDraft,sku:e.target.value})} placeholder="DAIRY-001"/></label>
          <label className="text-xs font-medium">Stock unit<select className={`${inputClass} mt-1`} value={itemDraft.unit} onChange={e=>setItemDraft({...itemDraft,unit:e.target.value as Unit})}>{units.map(unit=><option key={unit}>{unit}</option>)}</select></label>
          <label className="text-xs font-medium">Reorder level<input className={`${inputClass} mt-1`} type="number" min="0" step="0.001" required value={itemDraft.reorderLevel} onChange={e=>setItemDraft({...itemDraft,reorderLevel:e.target.value})}/></label>
        </div>
        <button className={`${buttonClass} mt-3`} disabled={busy}><PackagePlus size={15}/>Add item</button>
      </form>

      <form onSubmit={recordMovement} className="rounded-xl border border-[#e6ebe6] bg-[#fbfcfb] p-4">
        <div className="flex items-center gap-2"><Scale size={16} className="text-[#638098]"/><h3 className="text-sm font-semibold">Record stock movement</h3></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium">Stock item<select className={`${inputClass} mt-1`} required value={movementDraft.itemId} onChange={e=>setMovementDraft({...movementDraft,itemId:e.target.value})}><option value="">Select item</option>{items.filter(item=>item.active).map(item=><option key={item.inventory_item_id} value={item.inventory_item_id}>{item.name} · {quantity(item.on_hand)} {item.unit}</option>)}</select></label>
          <label className="text-xs font-medium">Movement<select className={`${inputClass} mt-1`} value={movementDraft.type} onChange={e=>setMovementDraft({...movementDraft,type:e.target.value as MovementType})}><option value="receipt">Receipt</option><option value="waste">Waste</option><option value="count_adjustment">Physical count</option></select></label>
          <label className="text-xs font-medium">{movementDraft.type==='count_adjustment'?'Counted quantity':'Quantity'}<input className={`${inputClass} mt-1`} type="number" min="0" step="0.001" required value={movementDraft.quantity} onChange={e=>setMovementDraft({...movementDraft,quantity:e.target.value})}/></label>
          <label className="text-xs font-medium">Reason<input className={`${inputClass} mt-1`} required minLength={3} maxLength={120} value={movementDraft.reason} onChange={e=>setMovementDraft({...movementDraft,reason:e.target.value})} placeholder={movementDraft.type==='waste'?'Spillage or spoilage':'Delivery or count reference'}/></label>
        </div>
        {movementDraft.type==='count_adjustment'&&movementDraft.itemId&&<p className="mt-2 text-[11px] text-[#687a6f]">System balance: {quantity(itemById.get(movementDraft.itemId)?.on_hand??0)} {itemById.get(movementDraft.itemId)?.unit}. The count is rejected if stock changes while you count.</p>}
        <button className={`${buttonClass} mt-3`} disabled={busy||!items.some(item=>item.active)}><Scale size={15}/>Save movement</button>
      </form>
    </div>

    <div className="mt-5 overflow-x-auto rounded-xl border border-[#e6ebe6]">
      <table className="w-full min-w-[600px] text-left text-xs"><thead className="bg-[#f7f9f7] text-[10px] uppercase tracking-wide text-[#86938a]"><tr><th className="px-3 py-2.5">Stock item</th><th className="px-3 py-2.5">SKU</th><th className="px-3 py-2.5 text-right">On hand</th><th className="px-3 py-2.5 text-right">Reorder</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5"/></tr></thead><tbody className="divide-y divide-[#edf0ed]">
        {items.map(item=><tr key={item.inventory_item_id} className={!item.active?'text-[#a1aaa4]':''}><td className="px-3 py-2.5 font-semibold text-[#43554a]">{item.name}<small className="ml-1 font-normal text-[#96a098]">{item.unit}</small></td><td className="px-3 py-2.5">{item.sku??'—'}</td><td className="px-3 py-2.5 text-right font-semibold">{quantity(item.on_hand)}</td><td className="px-3 py-2.5 text-right">{quantity(item.reorder_level)}</td><td className="px-3 py-2.5"><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${!item.active?'bg-[#f0f2f0] text-[#7d8881]':item.low_stock?'bg-[#fff3e0] text-[#9b6a1f]':'bg-[#edf6ef] text-[#4e805e]'}`}>{!item.active?'Archived':item.low_stock?'Low stock':'In stock'}</span></td><td className="px-3 py-2.5 text-right"><button type="button" className="rounded-md p-1.5 text-[#819087] hover:bg-[#f0f5f0]" title={item.active?'Archive item':'Restore item'} aria-label={`${item.active?'Archive':'Restore'} ${item.name}`} disabled={busy} onClick={()=>void setItemActive(item)}><Archive size={14}/></button></td></tr>)}
        {!items.length&&!busy&&<tr><td colSpan={6} className="px-3 py-8 text-center text-[#8d9991]">No inventory items yet. Add ingredients or supplies to start a stock ledger.</td></tr>}
      </tbody></table>
    </div>

    <div className="mt-5"><h3 className="text-sm font-semibold">Recent stock activity</h3>{movements.length?<ul className="mt-2 divide-y divide-[#edf0ed] rounded-xl border border-[#e6ebe6]">
      {movements.map(movement=>{const item=itemById.get(movement.inventory_item_id);return <li key={movement.movement_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-xs"><strong className="min-w-36 text-[#43554a]">{item?.name??'Inventory item'}</strong><span className="text-[#718077]">{movementName[movement.movement_type]}</span><span className={`font-semibold ${movement.quantity_delta<0?'text-[#a45c4c]':'text-[#4b7b56]'}`}>{movement.quantity_delta>0?'+':''}{quantity(movement.quantity_delta)} {item?.unit??''}</span><span className="min-w-36 flex-1 text-[#7f8c83]">{movement.reason}</span><time className="text-[10px] text-[#98a29b]">{new Date(movement.occurred_at).toLocaleString('en-IN')}</time></li>;})}
    </ul>:<p className="mt-2 rounded-xl bg-[#f8faf8] px-3 py-5 text-center text-xs text-[#8d9991]">No stock movements recorded.</p>}</div>
    <p className="mt-4 rounded-xl border border-[#efe5ce] bg-[#fffaf0] p-3 text-[10px] leading-5 text-[#8a7857]">Inventory changes require an internet connection in this release. Stock movements are append-only, outlet-scoped, and audited; offline stock entry, recipe consumption, suppliers, purchasing, and transfers are still in the roadmap.</p>
  </section>;
}
