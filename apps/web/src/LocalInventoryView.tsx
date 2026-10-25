import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { RefreshCw, Scale } from 'lucide-react';

interface InventoryItem {inventoryItemId:string;name:string;unit:string;active:boolean;reorderLevel:number;onHand:number;lowStock:boolean;}
type MovementType='receipt'|'waste'|'count_adjustment';
const movementLabels:Record<MovementType,string>={receipt:'Receipt',waste:'Waste',count_adjustment:'Physical count'};
const input='h-10 w-full rounded-lg border border-[#e3e9e4] bg-white px-3 text-xs outline-none focus:border-[#6b9b79]';

export default function LocalInventoryView(){
  const [items,setItems]=useState<InventoryItem[]>([]);
  const [itemId,setItemId]=useState('');
  const [type,setType]=useState<MovementType>('receipt');
  const [quantity,setQuantity]=useState('');
  const [reason,setReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const itemById=useMemo(()=>new Map(items.map(item=>[item.inventoryItemId,item])),[items]);
  const load=useCallback(async()=>{
    try{const response=await fetch('/api/inventory',{cache:'no-store'});if(!response.ok)throw new Error('Inventory is available only on the signed-in cashier laptop.');
      const rows=await response.json() as InventoryItem[];setItems(rows);setItemId(current=>rows.some(item=>item.inventoryItemId===current)?current:rows.find(item=>item.active)?.inventoryItemId??'');}
    catch(cause){setError(cause instanceof Error?cause.message:'Could not load local stock.');}
  },[]);
  useEffect(()=>{void load();},[load]);
  async function save(event:FormEvent){
    event.preventDefault();if(busy)return;
    const item=itemById.get(itemId);const amount=Number(quantity);const note=reason.trim();
    if(!item||!item.active){setError('Choose an active stock item.');return;}
    if(!Number.isFinite(amount)||amount<0||amount>1_000_000_000||Math.round(amount*1000)!==amount*1000
      ||(type!=='count_adjustment'&&amount<=0)||note.length<3||note.length>120){setError('Enter a valid quantity and a reason of 3 to 120 characters.');return;}
    setBusy(true);setError('');setNotice('');
    const commandId=crypto.randomUUID();
    try{const response=await fetch('/api/inventory/movements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      commandId,inventoryItemId:itemId,movementType:type,quantity:amount,expectedBalance:type==='count_adjustment'?item.onHand:null,reason:note,
    })});const result=await response.json() as {error?:string;inventory?:InventoryItem[]};
      if(!response.ok)throw new Error(result.error??'Could not save the stock movement.');
      if(result.inventory)setItems(result.inventory);
      setQuantity('');setReason('');setNotice(`${movementLabels[type]} saved on this laptop. It will sync when internet returns.`);
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not save the stock movement.');}
    finally{setBusy(false);}
  }
  return <section className="mx-auto w-full max-w-[1100px] flex-1 px-3 py-5 sm:px-5 lg:px-8" aria-labelledby="local-inventory-title">
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="text-[9px] font-bold uppercase tracking-[1px] text-[#87948d]">Local stock</p><h1 id="local-inventory-title" className="mt-1 text-2xl font-bold">Inventory</h1><p className="mt-1 text-xs text-[#7c8982]">Manager stock changes save to this laptop first and sync after internet returns.</p></div>
      <button type="button" onClick={()=>void load()} disabled={busy} className="flex h-9 items-center gap-2 rounded-lg border border-[#dfe7df] bg-white px-3 text-xs font-semibold text-[#456c54] disabled:opacity-50"><RefreshCw size={14}/>Refresh</button>
    </div>
    {error&&<p role="alert" className="mb-4 rounded-xl border border-[#f1c8c0] bg-[#fff4f1] px-4 py-3 text-xs text-[#9a493d]">{error}</p>}
    {notice&&<p role="status" className="mb-4 rounded-xl border border-[#cfe3d2] bg-[#f0f8f1] px-4 py-3 text-xs text-[#356d49]">{notice}</p>}
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="overflow-hidden rounded-xl border border-[#e5ebe6] bg-white"><div className="border-b border-[#edf0ed] px-4 py-3"><h2 className="text-sm font-semibold">Current stock</h2><p className="mt-1 text-[10px] text-[#8c9891]">A local snapshot of the outlet inventory.</p></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-[#f7f9f7] text-[10px] text-[#7d8982]"><tr><th className="px-4 py-2.5">Item</th><th className="px-4 py-2.5 text-right">On hand</th><th className="px-4 py-2.5 text-right">Reorder at</th><th className="px-4 py-2.5">Status</th></tr></thead><tbody>{items.map(item=><tr key={item.inventoryItemId} className="border-t border-[#edf0ed]"><td className="px-4 py-3 font-semibold">{item.name}<small className="ml-1 font-normal text-[#87948d]">{item.unit}</small></td><td className="px-4 py-3 text-right">{Number(item.onHand).toLocaleString('en-IN')}</td><td className="px-4 py-3 text-right">{Number(item.reorderLevel).toLocaleString('en-IN')}</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${item.lowStock?'bg-[#fff3e0] text-[#9b6a1f]':'bg-[#edf6ef] text-[#4e805e]'}`}>{item.lowStock?'Low stock':'In stock'}</span></td></tr>)}{!items.length&&<tr><td colSpan={4} className="px-4 py-12 text-center text-[#8c9891]">No stock items are cached on this laptop. Connect online once and add them in the manager portal.</td></tr>}</tbody></table></div>
      </div>
      <form onSubmit={save} className="h-fit rounded-xl border border-[#e5ebe6] bg-white p-4"><div className="flex items-center gap-2"><Scale size={16} className="text-[#638098]"/><h2 className="text-sm font-semibold">Record stock movement</h2></div>
        <label className="mt-4 block text-xs font-medium">Stock item<select className={`${input} mt-1.5`} required value={itemId} onChange={event=>setItemId(event.target.value)}><option value="">Select item</option>{items.filter(item=>item.active).map(item=><option key={item.inventoryItemId} value={item.inventoryItemId}>{item.name} · {Number(item.onHand).toLocaleString('en-IN')} {item.unit}</option>)}</select></label>
        <label className="mt-3 block text-xs font-medium">Movement<select className={`${input} mt-1.5`} value={type} onChange={event=>setType(event.target.value as MovementType)}><option value="receipt">Receipt</option><option value="waste">Waste</option><option value="count_adjustment">Physical count</option></select></label>
        <label className="mt-3 block text-xs font-medium">{type==='count_adjustment'?'Counted quantity':'Quantity'}<input className={`${input} mt-1.5`} type="number" min="0" step="0.001" required value={quantity} onChange={event=>setQuantity(event.target.value)}/></label>
        {type==='count_adjustment'&&itemId&&<p className="mt-2 text-[10px] text-[#718077]">Device balance: {itemById.get(itemId)?.onHand} {itemById.get(itemId)?.unit}. If the cloud balance changed while this device was offline, sync will show a conflict for review.</p>}
        <label className="mt-3 block text-xs font-medium">Reason<input className={`${input} mt-1.5`} required minLength={3} maxLength={120} value={reason} onChange={event=>setReason(event.target.value)} placeholder={type==='receipt'?'Delivery reference':'Spillage or count note'}/></label>
        <button disabled={busy||!items.some(item=>item.active)} className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#27694f] text-xs font-semibold text-white disabled:opacity-50">{busy?'Saving…':'Save locally'}</button>
        <p className="mt-3 text-[10px] leading-4 text-[#8b9790]">Only owner and manager accounts can change stock. Saved movements stay queued safely when offline.</p>
      </form>
    </div>
  </section>;
}
