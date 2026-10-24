import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, Check, ChefHat, ChevronDown, CircleHelp, Coffee, CreditCard, Flame, LayoutGrid, LoaderCircle, MapPin, Minus, MoreHorizontal, Plus, Printer, QrCode, Search, Send, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import type { CreateOrderCommand, KitchenOrder, MenuItem, ModifierOption, OrderLine, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage } from '@common-table/contracts';
import { DEMO_MENU } from '@common-table/contracts';
import { listQueuedOrders, queueOrder, removeQueuedOrder, type QueuedOrder } from './offline';

const CATEGORIES=['All items','Coffee','Brunch','Bakery'];
const formatMoney=(minor:number,currency='INR')=>new Intl.NumberFormat('en-IN',{style:'currency',currency}).format(minor/100);
const makeId=()=>crypto.randomUUID();
const CONTEXT_CACHE='common-table.edge-context.v1';

interface EdgeContext {tenantId:string;tenantName:string;outletId:string;outletName:string;terminalId:string;terminalName:string;locationLabel:string;currency:string;taxRateBps:number;}
function readCachedContext():EdgeContext|null{
  try{const value=localStorage.getItem(CONTEXT_CACHE);if(!value)return null;const parsed=JSON.parse(value) as Partial<EdgeContext>;return parsed.tenantId&&parsed.outletId&&parsed.terminalId?parsed as EdgeContext:null;}catch{return null;}
}

interface CartLine { id:string; item:MenuItem; quantity:number; modifiers:ModifierOption[]; }
interface LocalTicket { id:string; orderNumber:string; orderType:'dine_in'|'takeaway'; tableLabel:string|null; status:'sent'; note:string|null; createdAt:string; lines:OrderLine[]; pending:true; }
type TicketView=(KitchenOrder&{pending?:boolean});

function App(){
  const [page,setPage]=useState<'pos'|'kitchen'>('pos');
  const [menu,setMenu]=useState<MenuItem[]>(DEMO_MENU);
  const [category,setCategory]=useState('All items');
  const [search,setSearch]=useState('');
  const [orderType,setOrderType]=useState<'dine_in'|'takeaway'>('dine_in');
  const [table,setTable]=useState('Table 04');
  const [cart,setCart]=useState<CartLine[]>([]);
  const [note,setNote]=useState('');
  const [orders,setOrders]=useState<OrderRecord[]>([]);
  const [outletContext,setOutletContext]=useState<EdgeContext|null>(readCachedContext);
  const [taxRateBps,setTaxRateBps]=useState(0);
  const [queue,setQueue]=useState<QueuedOrder[]>([]);
  const [online,setOnline]=useState(navigator.onLine);
  const [connected,setConnected]=useState(false);
  const [busy,setBusy]=useState(false);
  const [toast,setToast]=useState('');
  const [checkoutOpen,setCheckoutOpen]=useState(false);
  const [checkoutCommandId,setCheckoutCommandId]=useState('');
  const [paymentMethod,setPaymentMethod]=useState<PaymentMethod>('cash');
  const [floorOpen,setFloorOpen]=useState(false);
  const [modifierItem,setModifierItem]=useState<MenuItem|null>(null);
  const [modifierSelection,setModifierSelection]=useState<string[]>([]);
  const [clock,setClock]=useState(new Date());

  const subtotal=cart.reduce((sum,line)=>sum+(line.item.priceMinor+line.modifiers.reduce((amount,modifier)=>amount+modifier.priceDeltaMinor,0))*line.quantity,0);
  const tax=Math.round(subtotal*taxRateBps/10000); // Demonstration rate only, must be configured for a real outlet.
  const total=subtotal+tax;
  const money=(minor:number)=>formatMoney(minor,outletContext?.currency??'INR');
  const filteredMenu=useMemo(()=>menu.filter(item=>(category==='All items'||item.category===category)&&(!search||item.name.toLowerCase().includes(search.toLowerCase()))),[menu,category,search]);
  const activeOrders=orders.filter(order=>['sent','preparing','ready'].includes(order.status));
  const pendingTickets:LocalTicket[]=queue.map((entry,index)=>({
    id:entry.command.commandId,orderNumber:`OFFLINE ${String(index+1).padStart(2,'0')}`,
    orderType:entry.command.orderType,tableLabel:entry.command.tableLabel??null,status:'sent',note:entry.command.note??null,
    createdAt:entry.queuedAt,pending:true,lines:entry.command.lines.flatMap(line=>{const item=menu.find(candidate=>candidate.id===line.menuItemId);const modifiers=item?.modifiers.filter(option=>line.modifierIds?.includes(option.id))??[];const unit=(item?.priceMinor??0)+modifiers.reduce((sum,option)=>sum+option.priceDeltaMinor,0);return item?[{id:`${entry.command.commandId}-${item.id}`,menuItemId:item.id,name:item.name,category:item.category,quantity:line.quantity,unitPriceMinor:unit,lineTotalMinor:unit*line.quantity,kitchenStation:item.kitchenStation,...(line.note?{note:line.note}:{}),modifiers}]:[];}),
  }));
  const tickets:TicketView[]=[...pendingTickets,...activeOrders];

  const notify=useCallback((message:string)=>{setToast(message);window.setTimeout(()=>setToast(''),2600);},[]);
  const refreshQueue=useCallback(async()=>{try{setQueue(await listQueuedOrders());}catch{notify('This browser could not open its local offline queue.');}},[notify]);
  const refreshOrders=useCallback(async()=>{try{const response=await fetch('/api/orders');if(!response.ok)throw new Error();setOrders(await response.json() as OrderRecord[]);}catch{/* The cached client keeps rendering while the local edge server is unreachable. */}},[]);

  const flushQueue=useCallback(async()=>{
    if(!navigator.onLine)return;
    const pending=await listQueuedOrders().catch(()=>[]);
    for(const entry of pending){
      try{
        const response=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(entry.command)});
        if(!response.ok)break;
        const order=await response.json() as OrderRecord;
        await removeQueuedOrder(entry.command.commandId);
        setOrders(previous=>[order,...previous.filter(row=>row.id!==order.id)]);
        setQueue(previous=>previous.filter(row=>row.command.commandId!==entry.command.commandId));
        notify(`Offline order synced · ${order.orderNumber}`);
      }catch{break;}
    }
  },[notify]);

  useEffect(()=>{
    void refreshQueue();void refreshOrders();
    fetch('/api/context').then(response=>response.ok?response.json():null).then((context:EdgeContext|null)=>{
      if(!context||typeof context.tenantId!=='string'||typeof context.outletId!=='string'||typeof context.terminalId!=='string')return;
      setOutletContext(context);setTaxRateBps(context.taxRateBps);try{localStorage.setItem(CONTEXT_CACHE,JSON.stringify(context));}catch{/* The current session can still work without caching outlet setup. */}
    }).catch(()=>undefined);
    fetch('/api/menu').then(response=>response.ok?response.json():null).then(rows=>{if(Array.isArray(rows)&&rows.length)setMenu(rows as MenuItem[]);}).catch(()=>undefined);
    const onOnline=()=>{setOnline(true);void flushQueue();};const onOffline=()=>setOnline(false);
    window.addEventListener('online',onOnline);window.addEventListener('offline',onOffline);
    const retry=window.setInterval(()=>{void flushQueue();void refreshOrders();},5000);
    return()=>{window.removeEventListener('online',onOnline);window.removeEventListener('offline',onOffline);window.clearInterval(retry);};
  },[flushQueue,refreshOrders,refreshQueue]);

  useEffect(()=>{const timer=window.setInterval(()=>setClock(new Date()),30000);return()=>window.clearInterval(timer);},[]);

  useEffect(()=>{
    let socket:WebSocket|undefined;let retryTimer:number|undefined;let cancelled=false;let delay=700;
    const connect=()=>{
      if(cancelled||!navigator.onLine)return;
      const address=new URL('/socket',window.location.href);address.protocol=address.protocol==='https:'?'wss:':'ws:';
      socket=new WebSocket(address);
      socket.onopen=()=>{setConnected(true);delay=700;};
      socket.onclose=()=>{setConnected(false);if(!cancelled){retryTimer=window.setTimeout(connect,delay);delay=Math.min(delay*1.7,10000);}};
      socket.onerror=()=>socket?.close();
      socket.onmessage=event=>{try{const message=JSON.parse(event.data) as ServerMessage;if(message.type==='kitchen.snapshot')setOrders(message.payload as OrderRecord[]);if(message.type==='order.created'||message.type==='order.updated'){const order=message.payload as OrderRecord;setOrders(previous=>[order,...previous.filter(row=>row.id!==order.id)]);}}catch{/* Ignore malformed socket frames and recover on the next snapshot. */}};
    };
    connect();return()=>{cancelled=true;window.clearTimeout(retryTimer);socket?.close();};
  },[]);

  function addItem(item:MenuItem){if(item.modifiers.length){setModifierItem(item);setModifierSelection(item.modifiers.filter(option=>option.group!=='Add-on'&&item.modifiers.find(candidate=>candidate.group===option.group)?.id===option.id).map(option=>option.id));return;}addConfiguredItem(item,[]);}
  function addConfiguredItem(item:MenuItem,modifierIds:string[]){const modifiers=item.modifiers.filter(option=>modifierIds.includes(option.id));setCart(previous=>{const signature=modifierIds.slice().sort().join('|');const found=previous.find(line=>line.item.id===item.id&&line.modifiers.map(option=>option.id).sort().join('|')===signature);return found?previous.map(line=>line.id===found.id?{...line,quantity:line.quantity+1}:line):[...previous,{id:makeId(),item,quantity:1,modifiers}];});}
  function toggleModifier(option:ModifierOption){setModifierSelection(previous=>option.group==='Add-on'?(previous.includes(option.id)?previous.filter(id=>id!==option.id):[...previous,option.id]):[...previous.filter(id=>!modifierItem?.modifiers.some(candidate=>candidate.id===id&&candidate.group===option.group)),option.id]);}
  function changeQuantity(lineId:string,direction:number){setCart(previous=>previous.flatMap(line=>line.id!==lineId?[line]:line.quantity+direction<=0?[]:[{...line,quantity:line.quantity+direction}]));}
  function buildCommand(commandId:string=makeId()):CreateOrderCommand{
    if(!outletContext)throw new Error('This device has not loaded outlet setup from the local edge server.');
    return {commandId,tenantId:outletContext.tenantId,outletId:outletContext.outletId,terminalId:outletContext.terminalId,orderType,...(orderType==='dine_in'?{tableLabel:table}:{}),guestCount:2,...(note?{note}:{}),lines:cart.map(line=>({menuItemId:line.item.id,quantity:line.quantity,modifierIds:line.modifiers.map(option=>option.id)}))};
  }

  async function sendToKitchen(){
    if(!cart.length||busy)return;if(!outletContext){notify('Connect to the outlet edge server before sending or queueing an order.');return;}setBusy(true);const command=buildCommand();
    try{
      const response=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
      if(!response.ok){if(response.status<500){const problem=await response.json().catch(()=>({}));notify(problem.error??'The edge server rejected this order.');setBusy(false);return;}throw new Error('Could not save the order on the edge server.');}
      const order=await response.json() as OrderRecord;setOrders(previous=>[order,...previous.filter(row=>row.id!==order.id)]);notify(`${order.orderNumber} sent to kitchen`);
    }catch{
      try{await queueOrder(command);await refreshQueue();notify('Order saved locally. It will sync when the edge server reconnects.');}
      catch{notify('Could not save this order offline. Check browser storage permissions.');setBusy(false);return;}
    }
    setCart([]);setNote('');setBusy(false);
  }

  async function recordPayment(){
    if(!cart.length||busy)return;if(!outletContext){notify('Connect to the outlet edge server before taking payment.');return;}setBusy(true);
    try{
      const createResponse=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(buildCommand(checkoutCommandId))});
      if(!createResponse.ok)throw new Error();
      const order=await createResponse.json() as OrderRecord;
      const payment:PaymentCommand={commandId:makeId(),orderId:order.id,method:paymentMethod,amountMinor:order.totalMinor};
      const response=await fetch(`/api/orders/${order.id}/payment`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payment)});
      if(!response.ok)throw new Error();const paid=await response.json() as OrderRecord;setOrders(previous=>[paid,...previous.filter(row=>row.id!==paid.id)]);setCheckoutOpen(false);setCart([]);setNote('');notify(`Demo payment recorded · ${paid.invoiceNumber}`);
    }catch{notify('Payment needs the edge server. This prototype does not process real payments.');}
    setBusy(false);
  }

  async function updateTicket(ticket:TicketView,next:OrderStatus){
    if(ticket.pending){notify('This offline ticket will sync before kitchen status updates.');return;}
    try{const response=await fetch(`/api/orders/${ticket.id}/status`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:next})});if(!response.ok)throw new Error();const updated=await response.json() as OrderRecord;setOrders(previous=>[updated,...previous.filter(row=>row.id!==updated.id)]);}
    catch{notify('Could not update the kitchen ticket.');}
  }

  async function testPrinter(){try{const response=await fetch('/api/printer/test',{method:'POST'});if(!response.ok)throw new Error();notify('Test ticket sent to the mock printer socket.');}catch{notify('Mock printer is not connected.');}}

  return <div className="flex min-h-screen bg-[#f5f7f5] text-[#192522]">
    <aside className="hidden w-[236px] shrink-0 flex-col border-r border-[#e7ece8] bg-[#fbfcfa] px-3 py-5 md:flex">
      <div className="mb-6 flex items-center gap-2.5 px-2"><div className="grid size-9 place-items-center rounded-xl bg-[#28694f] font-extrabold tracking-[-2px] text-[#fff6e5]">ct</div><div><strong className="block text-[13px] font-extrabold tracking-[-.4px]">common table</strong><span className="text-[9px] uppercase tracking-[.7px] text-[#89968f]">restaurant OS</span></div></div>
      <button className="mb-6 flex items-center gap-2 rounded-xl border border-[#e6ece7] bg-[#f1f5f1] px-2.5 py-2 text-left"><span className="grid size-8 place-items-center rounded-lg bg-white text-[#34704f]">⌂</span><span className="min-w-0 flex-1"><strong className="block truncate text-[10px]">{outletContext?.locationLabel??'Outlet not connected'}</strong><small className="text-[9px] text-[#87948d]">{outletContext?.outletName??'Connect the local edge'}</small></span><ChevronDown size={14} className="text-[#89958f]" /></button>
      <p className="mb-2 px-2 text-[9px] font-bold tracking-[1px] text-[#9aa49e]">WORKSPACE</p>
      <nav className="space-y-1">
        <button onClick={()=>setPage('pos')} className={`flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[11px] ${page==='pos'?'bg-[#e9f4ed] font-bold text-[#27694f]':'text-[#718078] hover:bg-[#f1f5f1]'}`}><LayoutGrid size={16} />Point of sale <span className="ml-auto text-[9px] opacity-60">1</span></button>
        <button onClick={()=>setPage('kitchen')} className={`flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[11px] ${page==='kitchen'?'bg-[#e9f4ed] font-bold text-[#27694f]':'text-[#718078] hover:bg-[#f1f5f1]'}`}><ChefHat size={16} />Kitchen display{tickets.length>0&&<span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[9px]">{tickets.length}</span>}</button>
      </nav>
      <div className="mt-auto">
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-[#f1f6f1] p-2.5"><span className={`mt-1 size-2 rounded-full ${online&&connected?'bg-[#54a474]':'bg-[#d79543]'}`} /><span><strong className="block text-[9px]">{online&&connected?'Edge server connected':online?'Waiting for local edge':'Offline · local queue active'}</strong><small className="text-[8px] text-[#87948d]">{queue.length?`${queue.length} order${queue.length===1?'':'s'} awaiting sync`:'Orders saved on this device'}</small></span></div>
        <div className="flex items-center gap-2 border-t border-[#e8ede9] px-1 pt-3"><span className="grid size-8 place-items-center rounded-full bg-[#f2ddce] text-[9px] font-bold text-[#80513d]">AR</span><span><strong className="block text-[10px]">Alex Rivera</strong><small className="text-[9px] text-[#89958e]">Shift manager</small></span><MoreHorizontal size={16} className="ml-auto text-[#92a098]" /></div>
      </div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[58px] items-center justify-between border-b border-[#e7ece8] bg-white/70 px-4 md:px-8">
        <div className="flex items-center gap-2 text-[10px] text-[#89958f]"><span className="md:hidden font-bold text-[#28694f]">ct</span><span>{outletContext?.outletName??'Common Table POS'}</span><span className="text-[#c3cbc6]">/</span><strong className="font-semibold text-[#405149]">{page==='pos'?'Point of sale':'Kitchen display'}</strong></div>
        <div className="flex items-center gap-2 sm:gap-4"><div className="hidden items-center gap-2 rounded-full border border-[#e6ebe7] px-2.5 py-1.5 text-[9px] text-[#65736c] sm:flex"><i className="size-1.5 rounded-full bg-[#55a877]" />Morning shift <span className="text-[#a4ada7]">09:00–17:00</span></div><button onClick={testPrinter} title="Send test to mock printer" className="grid size-7 place-items-center rounded-full border border-[#e6ebe7] bg-white text-[#7d8983]"><Printer size={13}/></button><button title="Help" className="grid size-7 place-items-center rounded-full border border-[#e6ebe7] bg-white text-[#7d8983]"><CircleHelp size={13}/></button><div className="text-right text-[8px] tracking-[.6px] text-[#97a19b]">{clock.toLocaleDateString('en-IN',{weekday:'short',month:'short',day:'2-digit'}).toUpperCase()} <strong className="block text-[10px] tracking-normal text-[#42534b]">{clock.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</strong></div></div>
      </header>

      {page==='pos'?<section className="mx-auto w-full max-w-[1540px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
        <div className="mb-5 flex items-end justify-between gap-3"><div><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">{clock.toLocaleDateString('en-IN',{weekday:'long'}).toUpperCase()} SERVICE <span className="ml-1.5 text-[#46805e]">● LIVE</span></p><h1 className="font-[Manrope,Inter,sans-serif] text-[23px] font-bold tracking-[-1px] text-[#24312c] sm:text-[26px]">Good morning, Alex <span className="text-[#d3974e]">✳</span></h1><p className="mt-1 text-[10px] text-[#8a9690]">A little more coffee, a little less waiting.</p></div><button onClick={()=>{if(cart.length)notify('Send or charge this order before starting a new one.');else{setNote('');notify('New order ready.');}}} className="hidden h-9 items-center gap-2 rounded-lg border border-[#dfe6e1] bg-white px-3 text-[10px] font-bold text-[#40564b] sm:flex"><Plus size={14}/>New order</button></div>

        <div className="grid items-start gap-3 xl:grid-cols-[minmax(500px,1.55fr)_minmax(330px,.85fr)]">
          <section className="overflow-hidden rounded-[14px] border border-[#e8ede9] bg-white shadow-[0_10px_24px_rgba(25,37,34,.045)]">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#edf0ed] p-3">
              <div className="flex rounded-lg bg-[#f2f5f2] p-[3px]"><button onClick={()=>setOrderType('dine_in')} className={`rounded-md px-2.5 py-1.5 text-[9px] ${orderType==='dine_in'?'bg-white font-bold text-[#28694f] shadow-sm':'text-[#829089]'}`}>▤ Dine in</button><button onClick={()=>setOrderType('takeaway')} className={`rounded-md px-2.5 py-1.5 text-[9px] ${orderType==='takeaway'?'bg-white font-bold text-[#28694f] shadow-sm':'text-[#829089]'}`}>↗ Takeaway</button></div>
              {orderType==='dine_in'&&<><label className="flex h-[31px] items-center gap-2 rounded-lg border border-[#e8ede9] px-2 text-[9px] text-[#89948e]">Table<select value={table} onChange={event=>setTable(event.target.value)} className="appearance-none bg-transparent pr-1 text-[10px] font-semibold text-[#38483f]"><option>Table 04</option><option>Table 01</option><option>Table 02</option><option>Table 03</option><option>Table 05</option><option>Patio 01</option></select><ChevronDown size={12}/></label><button onClick={()=>setFloorOpen(true)} className="flex h-[31px] items-center gap-1 rounded-lg border border-[#e8ede9] px-2 text-[9px] font-semibold text-[#4b6657]"><MapPin size={12}/>Floor plan</button></>}
              {orderType==='dine_in'&&<span className="ml-auto flex items-center gap-1.5 rounded-md bg-[#f7f9f7] px-2 py-2 text-[9px] text-[#78847e]">♙ 2 guests <ChevronDown size={12}/></span>}
            </div>
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-4"><div><h2 className="text-[14px] font-bold tracking-[-.3px]">Menu</h2><span className="text-[9px] text-[#98a29d]">Find something good</span></div><label className="flex h-[31px] w-[min(190px,48%)] items-center gap-1.5 rounded-lg border border-[#e8ede9] px-2 text-[#8c9891]"><Search size={14}/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search menu" className="w-full min-w-0 border-0 bg-transparent text-[9px] text-[#324239] outline-none placeholder:text-[#a4aea8]"/><kbd className="hidden rounded border border-[#e8ede9] px-1 text-[8px] sm:block">⌘K</kbd></label></div>
            <div className="flex gap-1.5 overflow-x-auto px-4 pb-3">{CATEGORIES.map(value=><button key={value} onClick={()=>setCategory(value)} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-[9px] ${category===value?'border-[#294f3f] bg-[#294f3f] text-white':'border-[#e8ede9] bg-white text-[#7e8a84]'}`}>{value}</button>)}</div>
            <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-3 2xl:grid-cols-4">{filteredMenu.map(item=><button key={item.id} onClick={()=>addItem(item)} className="group min-w-0 rounded-[11px] border border-[#edf0ed] bg-white p-2 text-left transition hover:-translate-y-0.5 hover:border-[#b7d4c3] hover:shadow-sm"><span className="relative mb-2 flex h-[70px] items-center justify-center overflow-hidden rounded-lg text-[31px]" style={{backgroundColor:item.color}}>{item.emoji}{item.vegetarian&&<i title="Vegetarian" className="absolute right-1.5 top-1.5 size-3 rounded-[2px] border border-[#438b52] after:mx-auto after:mt-[3px] after:block after:size-[5px] after:rounded-full after:bg-[#438b52] after:content-['']"/>}</span><span className="flex min-h-[26px] items-start justify-between gap-1"><strong className="text-[10px] font-semibold leading-[1.3] text-[#35443d]">{item.name}</strong>{item.tag&&<small className="shrink-0 rounded bg-[#fbf3e7] px-1 py-0.5 text-[6px] font-semibold tracking-[.3px] text-[#a07038]">{item.tag}</small>}</span><span className="mt-2 flex items-center justify-between"><strong className="text-[10px] text-[#2a3d33]">{money(item.priceMinor)}</strong><span className="grid size-[19px] place-items-center rounded-md bg-[#eef5ef] text-[14px] text-[#367252]">+</span></span></button>)}</div>
            <div className="border-t border-[#f0f2f0] px-4 py-2.5 text-[8px] text-[#98a29d]">Tap an item to add it to the order <span className="float-right">Prices in ₹</span></div>
          </section>

          <aside className="flex min-h-[510px] flex-col rounded-[14px] border border-[#e8ede9] bg-white p-3.5 shadow-[0_10px_24px_rgba(25,37,34,.045)] xl:sticky xl:top-3">
            <div className="flex items-center justify-between"><div><p className="mb-1 text-[8px] font-bold tracking-[1px] text-[#89958f]">CURRENT ORDER</p><h2 className="text-[14px] font-bold">{orderType==='dine_in'?table:'Takeaway'} <span className="font-normal text-[#9ba59f]">· New</span></h2></div><button className="text-[#8c9891]" aria-label="Order options"><MoreHorizontal size={18}/></button></div>
            <div className="mt-2.5 flex items-center gap-1.5 text-[8px] text-[#9aa49e]"><span className="rounded bg-[#eaf4ed] px-1.5 py-1 text-[7px] font-bold tracking-[.4px] text-[#36714f]">{orderType.toUpperCase().replace('_',' ')}</span><span>Started just now</span><span>·</span><span>Alex</span></div>
            <div className="min-h-[130px] flex-1 overflow-auto py-2">{cart.length?cart.map(line=>{const unit=line.item.priceMinor+line.modifiers.reduce((sum,modifier)=>sum+modifier.priceDeltaMinor,0);return <div key={line.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-[#f0f2f0] py-2.5"><div className="min-w-0"><strong className="block text-[10px] font-semibold text-[#36453e]">{line.item.name}</strong><small className="mt-1 block text-[8px] text-[#9aa49f]">{line.item.category} · {money(unit)} each</small>{line.modifiers.map(modifier=><small key={modifier.id} className="mt-0.5 block text-[8px] text-[#718078]">↳ {modifier.name}{modifier.priceDeltaMinor?` +${money(modifier.priceDeltaMinor)}`:''}</small>)}</div><div className="flex items-center gap-1.5"><div className="flex items-center gap-1 rounded-md border border-[#edf0ed] px-1.5 py-1"><button onClick={()=>changeQuantity(line.id,-1)} aria-label="Decrease quantity" className="text-[#65756c]"><Minus size={11}/></button><span className="min-w-3 text-center text-[9px]">{line.quantity}</span><button onClick={()=>changeQuantity(line.id,1)} aria-label="Increase quantity" className="text-[#65756c]"><Plus size={11}/></button></div><strong className="min-w-[49px] text-right text-[9px]">{money(unit*line.quantity)}</strong><button onClick={()=>changeQuantity(line.id,-line.quantity)} aria-label="Remove item" className="text-[#c09b92]"><Trash2 size={12}/></button></div></div>; }):<div className="flex h-[150px] flex-col items-center justify-center gap-1.5 text-center"><Coffee size={27} className="mb-1 text-[#d7e2d9]"/><strong className="text-[10px] text-[#65746c]">Your order starts here</strong><span className="text-[9px] text-[#9aa59f]">Choose a favorite from the menu.</span></div>}</div>
            <label className="mb-2 flex h-8 items-center gap-1.5 rounded-md border border-dashed border-[#dce5de] px-2 text-[#7d9385]"><Plus size={13}/><input value={note} onChange={event=>setNote(event.target.value)} maxLength={140} placeholder="Add a note for the kitchen" className="w-full bg-transparent text-[9px] text-[#324239] outline-none placeholder:text-[#9ca8a1]"/></label>
            <div className="border-t border-[#edf0ed] pt-2.5"><div className="mb-2 flex justify-between text-[9px] text-[#87938c]"><span>Subtotal</span><span>{money(subtotal)}</span></div><div className="mb-2 flex justify-between text-[9px] text-[#87938c]"><span>Tax <span className="text-[8px] text-[#a4aea8]">(demo {taxRateBps/100}%)</span></span><span>{money(tax)}</span></div><div className="flex items-center justify-between border-t border-dashed border-[#e6ebe7] pt-2.5"><strong className="text-[11px]">Total</strong><strong className="text-[17px] tracking-[-.4px]">{money(total)}</strong></div><p className="mt-1.5 text-[8px] text-[#a2aaa5]">Sample tax only. Set local rules before live use.</p></div>
            <div className="mt-3 grid grid-cols-2 gap-2"><button disabled={!cart.length||busy} onClick={()=>void sendToKitchen()} className="flex h-10 items-center justify-center gap-1.5 rounded-lg border border-[#dfe8e1] bg-white text-[9px] font-bold text-[#43624f] disabled:cursor-not-allowed disabled:opacity-40"><Send size={13}/>{busy?<LoaderCircle size={12} className="animate-spin"/>:'Send to kitchen'}</button><button disabled={!cart.length||busy} onClick={()=>{setCheckoutCommandId(makeId());setCheckoutOpen(true);}} className="flex h-10 items-center gap-1.5 rounded-lg bg-[#27694f] px-2 text-[9px] font-bold text-white hover:bg-[#1d503c] disabled:cursor-not-allowed disabled:opacity-40"><span>Charge</span><strong className="ml-auto text-[10px]">{money(total)}</strong><span>→</span></button></div>
            <div className="mt-2.5 text-center text-[8px] text-[#a0aaa4]">⌁ Orders saved locally and synced to the edge server</div>
          </aside>
        </div>
      </section>:<section className="mx-auto w-full max-w-[1540px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
        <div className="mb-5 flex items-end justify-between"><div><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">JUNIPER CAFÉ <span className="ml-1.5 text-[#46805e]">● LIVE BOARD</span></p><h1 className="text-[23px] font-bold tracking-[-1px] sm:text-[26px]">Kitchen display <span className="text-[#d3974e]">♨</span></h1><p className="mt-1 text-[10px] text-[#8a9690]">Keep the good stuff moving.</p></div><button onClick={testPrinter} className="flex h-9 items-center gap-2 rounded-lg border border-[#dfe6e1] bg-white px-3 text-[9px] font-bold text-[#40564b]"><Printer size={13}/>Test printer</button></div>
        <div className="mb-3 flex items-center gap-4 rounded-lg border border-[#e8ede9] bg-white p-3 text-[9px] text-[#758179]"><span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-[#eaa64c]"/>In progress <strong className="text-[#34443c]">{tickets.filter(ticket=>ticket.status==='sent'||ticket.status==='preparing').length}</strong></span><span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-[#5eaa7a]"/>Ready to serve <strong className="text-[#34443c]">{tickets.filter(ticket=>ticket.status==='ready').length}</strong></span><span className="ml-auto hidden text-[8px] text-[#a1aaa5] sm:block">{connected?'Connected · Live updates on':'Waiting for edge connection'}</span></div>
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{tickets.map(ticket=><article key={ticket.id} className="overflow-hidden rounded-xl border border-[#e7ece8] bg-white shadow-[0_10px_24px_rgba(25,37,34,.045)]"><header className="flex items-start justify-between border-b border-[#edf0ed] p-3"><div><span className="text-[8px] tracking-[.7px] text-[#89958f]">{ticket.pending?'OFFLINE · PENDING SYNC':ticket.status.toUpperCase()} · {ticket.orderNumber}</span><h3 className="mt-1 text-[14px] font-bold">{ticket.orderType==='dine_in'?ticket.tableLabel:'Takeaway'}</h3></div><span className="rounded-md bg-[#fff5e8] px-2 py-1 text-[8px] font-bold text-[#ab702d]">{Math.max(0,Math.floor((Date.now()-new Date(ticket.createdAt).getTime())/60000))||'Just now'}{typeof Math.floor((Date.now()-new Date(ticket.createdAt).getTime())/60000)==='number'&&Date.now()-new Date(ticket.createdAt).getTime()>=60000?' min':''}</span></header><div className="flex gap-1.5 px-3 py-2 text-[8px] text-[#8a968f]"><span>{ticket.orderType.toUpperCase().replace('_',' ')}</span><span>·</span><span>{ticket.lines.reduce((sum,line)=>sum+line.quantity,0)} items</span><span>·</span><span>Alex</span></div><div className="px-3 pb-2">{ticket.lines.map(line=><div key={line.id} className="flex gap-2 border-b border-dashed border-[#edf0ed] py-2 last:border-0"><span className="grid size-5 place-items-center rounded bg-[#f2f5f2] text-[9px] font-bold text-[#466151]">{line.quantity}</span><span><strong className="block text-[9px] font-semibold">{line.name}</strong><small className="text-[8px] text-[#9aa49e]">{line.kitchenStation}{line.note?` · ${line.note}`:''}</small>{line.modifiers.map(modifier=><small key={modifier.id} className="block text-[8px] text-[#62746a]">↳ {modifier.name}</small>)}</span></div>)}</div>{ticket.note&&<p className="mx-3 mb-2 rounded bg-[#fff8ed] p-2 text-[8px] text-[#a17a48]">Note: {ticket.note}</p>}<div className="flex gap-1.5 border-t border-[#edf0ed] bg-[#fbfcfb] p-2.5"><button disabled={ticket.pending} onClick={()=>void updateTicket(ticket,ticket.status==='sent'?'preparing':'ready')} className="rounded-md border border-[#e5ebe6] bg-white px-2.5 py-2 text-[8px] font-semibold text-[#607168] disabled:opacity-50">{ticket.status==='sent'?'Start preparing':'Mark ready'}</button><button disabled={ticket.pending} onClick={()=>void updateTicket(ticket,'ready')} className="ml-auto flex items-center gap-1.5 rounded-md border border-[#d7e8db] bg-[#eef6f0] px-2.5 py-2 text-[8px] font-semibold text-[#37704c] disabled:opacity-50"><Check size={12}/>Ready</button></div></article>)}{!tickets.length&&<div className="col-span-full flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#dfe8e1] bg-white text-center"><Flame size={25} className="text-[#d7e2d9]"/><strong className="text-[12px] text-[#607168]">Kitchen is clear</strong><span className="text-[9px] text-[#91a096]">Orders sent from the POS appear here.</span></div>}</div>
      </section>}
      <footer className="mx-3 flex h-8 items-center justify-between border-t border-[#e9eeea] text-[7px] tracking-[.65px] text-[#a4ada7] sm:mx-8"><span>COMMON TABLE · POS PROTOTYPE</span><span>{online?<Wifi size={11} className="inline text-[#6f9b79]"/>:<WifiOff size={11} className="inline text-[#d79543]"/>} <span className="ml-1">Local-first · {queue.length} pending</span></span></footer>
    </main>

    {floorOpen&&<div className="fixed inset-0 z-20 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><div className="w-full max-w-[510px] rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><div><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">DINING ROOM</span><h2 className="mt-1 text-lg font-bold">Choose a table</h2></div><button onClick={()=>setFloorOpen(false)} className="grid size-7 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div><div className="mb-3 mt-2 flex gap-3 text-[8px] text-[#84918a]"><span><i className="mr-1 inline-block size-2 rounded-full bg-[#74a984]"/>Available</span><span><i className="mr-1 inline-block size-2 rounded-full bg-[#e6b66f]"/>In service</span></div><div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{['Table 01','Table 02','Table 03','Table 04','Table 05','Patio 01','Bar 01','Bar 02'].map((name,index)=>{const occupied=orders.some(order=>order.tableLabel===name&&['sent','preparing','ready'].includes(order.status));return <button key={name} disabled={occupied} onClick={()=>{setTable(name);setFloorOpen(false);}} className={`flex h-[83px] flex-col items-center justify-center rounded-xl border text-center ${name===table?'border-[#4b8a65] bg-[#edf6ef] text-[#28694f]':occupied?'cursor-not-allowed border-[#efe4d4] bg-[#fff9f0] text-[#aa875a]':'border-[#e7ece8] bg-[#fbfcfb] text-[#64736b] hover:border-[#a9c9b1]'}`}><LayoutGrid size={19}/><strong className="mt-2 text-[9px]">{name}</strong><small className="mt-0.5 text-[7px]">{occupied?'In service':`${index<5?2:4} seats`}</small></button>;})}</div><p className="mt-3 text-[8px] text-[#98a29d]">Occupied tables are locked in this prototype; order transfer and merge come later.</p></div></div>}
    {modifierItem&&<div className="fixed inset-0 z-20 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><div className="w-full max-w-[430px] rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">CUSTOMIZE ITEM</span><button onClick={()=>setModifierItem(null)} className="grid size-7 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div><h2 className="mt-2 text-lg font-bold">{modifierItem.name}</h2><p className="mt-1 text-[9px] text-[#89958e]">Choose the options for this item.</p><div className="mt-4 space-y-4">{[...new Set(modifierItem.modifiers.map(option=>option.group))].map(group=><fieldset key={group}><legend className="mb-2 text-[9px] font-bold text-[#526259]">{group}<span className="ml-1 font-normal text-[#9da7a1]">{group==='Add-on'?'· optional':'· choose one'}</span></legend><div className="space-y-1">{modifierItem.modifiers.filter(option=>option.group===group).map(option=>{const selected=modifierSelection.includes(option.id);return <button type="button" key={option.id} onClick={()=>toggleModifier(option)} className={`flex w-full items-center rounded-lg border px-3 py-2 text-left text-[9px] ${selected?'border-[#a7c8b0] bg-[#f1f7f2] text-[#35684a]':'border-[#edf0ed] text-[#56665d]'}`}><span className={`mr-2 grid size-3.5 place-items-center rounded-full border ${selected?'border-[#3f865b] bg-[#3f865b] text-white':'border-[#cbd5ce]'}`}>{selected&&<Check size={9}/>}</span>{option.name}<span className="ml-auto">{option.priceDeltaMinor?`+${money(option.priceDeltaMinor)}`:'Included'}</span></button>;})}</div></fieldset>)}</div><div className="mt-4 flex items-center justify-between border-t border-[#edf0ed] pt-3"><span className="text-[9px] text-[#87938c]">Item total</span><strong className="text-[14px]">{money(modifierItem.priceMinor+modifierItem.modifiers.filter(option=>modifierSelection.includes(option.id)).reduce((sum,option)=>sum+option.priceDeltaMinor,0))}</strong></div><button onClick={()=>{addConfiguredItem(modifierItem,modifierSelection);setModifierItem(null);}} className="mt-3 flex h-10 w-full items-center rounded-lg bg-[#27694f] px-3 text-[9px] font-bold text-white">Add to order <span className="ml-auto">→</span></button></div></div>}
    {checkoutOpen&&<div className="fixed inset-0 z-20 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><div className="w-full max-w-[400px] rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">COMPLETE ORDER</span><button onClick={()=>setCheckoutOpen(false)} className="grid size-7 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div><h2 className="mt-3 text-xl font-bold tracking-[-.5px]">Take payment</h2><p className="mt-1 text-[10px] text-[#8b9790]">{orderType==='dine_in'?table:'Takeaway'} · {cart.reduce((sum,line)=>sum+line.quantity,0)} items</p><div className="mt-4 flex items-center justify-between rounded-xl bg-[#f4f7f4] p-3 text-[10px] text-[#748078]"><span>Amount due</span><strong className="text-xl text-[#294437]">{money(total)}</strong></div><p className="mb-2 mt-4 text-[9px] text-[#748078]">Choose a payment method</p><div className="grid grid-cols-3 gap-2">{([{id:'cash',name:'Cash',Icon:Banknote},{id:'upi',name:'UPI',Icon:QrCode},{id:'card',name:'Card',Icon:CreditCard}] as const).map(method=><button key={method.id} onClick={()=>setPaymentMethod(method.id)} className={`flex h-14 flex-col items-center justify-center gap-1 rounded-lg border text-[9px] ${paymentMethod===method.id?'border-[#93bba0] bg-[#edf6ef] text-[#34704c]':'border-[#e5ebe6] text-[#78857e]'}`}><method.Icon size={15}/><strong>{method.name}</strong></button>)}</div><div className="my-3 rounded-md bg-[#fcf6eb] p-2 text-[8px] leading-relaxed text-[#9b805d]">Prototype only. Records a demo tender on the edge server; no real payment is processed.</div><button onClick={()=>void recordPayment()} disabled={busy} className="flex h-10 w-full items-center gap-2 rounded-lg bg-[#27694f] px-3 text-[9px] font-bold text-white hover:bg-[#1d503c] disabled:opacity-60">{busy?<LoaderCircle size={14} className="animate-spin"/>:'Record demo payment'}<span className="ml-auto">→</span></button></div></div>}
    {toast&&<div role="status" className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-lg bg-[#253b30] px-4 py-2.5 text-[10px] text-white shadow-xl">{toast}</div>}
  </div>;
}

export default App;
