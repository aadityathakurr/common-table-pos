import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, BarChart3, Check, ChefHat, ChevronDown, CircleHelp, Coffee, CreditCard, Flame, LayoutGrid, LoaderCircle, MapPin, Minus, MoreHorizontal, Plus, Printer, QrCode, Search, Send, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import type { CreateOrderCommand, KitchenOrder, MenuItem, ModifierOption, OrderLine, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage, ShiftSummary } from '@common-table/contracts';
import { DEMO_MENU } from '@common-table/contracts';
import { listQueuedOrders, queueOrder, removeQueuedOrder, type QueuedOrder } from './offline';
import { supabase } from './supabase';
import ReportsView from './ReportsView';

const formatMoney=(minor:number,currency='INR')=>new Intl.NumberFormat('en-IN',{style:'currency',currency}).format(minor/100);
const makeId=()=>crypto.randomUUID();
const CONTEXT_CACHE='common-table.edge-context.v1';

interface EdgeContext {tenantId:string;tenantName:string;outletId:string;outletName:string;terminalId:string;terminalName:string;locationLabel:string;currency:string;timeZone?:string;taxRateBps:number;}
interface CloudMenuContext {tenantId:string;outletId:string;outletName?:string;currency?:string;}
interface CloudMenuRow {item_id:string;category_id:string;name:string;price_minor:number;emoji:string;color:string;tag:string|null;vegetarian:boolean;available:boolean;kitchen_station:string;modifiers:ModifierOption[]|null;}
interface SyncStatus {configured:boolean;pending:number;failed:number;lastSyncedAt:string|null;lastError:string|null;menu?:{version?:string;lastSyncedAt?:string;lastError:string|null};}
interface EdgeStaffSession {userId:string;email:string;displayName:string;role:'owner'|'manager'|'cashier'|'kitchen'|'viewer';tenantId:string;outletId:string;expiresAt:number;}
function readCachedContext():EdgeContext|null{
  try{const value=localStorage.getItem(CONTEXT_CACHE);if(!value)return null;const parsed=JSON.parse(value) as Partial<EdgeContext>;return parsed.tenantId&&parsed.outletId&&parsed.terminalId?parsed as EdgeContext:null;}catch{return null;}
}
function readCloudMenuContext():CloudMenuContext|null{
  try{const value=localStorage.getItem('common-table.menu-context.v1');if(!value)return null;const parsed=JSON.parse(value) as Partial<CloudMenuContext>;return parsed.tenantId&&parsed.outletId?parsed as CloudMenuContext:null;}catch{return null;}
}

interface CartLine { id:string; item:MenuItem; quantity:number; modifiers:ModifierOption[]; }
interface LocalTicket { id:string; ticketId:string; kitchenStation:string; ticketStatus:'new'; orderNumber:string; orderType:'dine_in'|'takeaway'; tableLabel:string|null; status:'sent'; note:string|null; createdAt:string; lines:OrderLine[]; pending:true; }
type TicketView=(KitchenOrder&{pending?:boolean});
function ticketStatus(ticket:TicketView):'new'|'preparing'|'ready'{
  if(ticket.ticketStatus==='new'||ticket.ticketStatus==='preparing'||ticket.ticketStatus==='ready')return ticket.ticketStatus;
  return ticket.status==='sent'?'new':ticket.status==='preparing'?'preparing':'ready';
}

function App(){
  const [page,setPage]=useState<'pos'|'kitchen'|'reports'>('pos');
  const [menu,setMenu]=useState<MenuItem[]>(DEMO_MENU);
  const [menuSource,setMenuSource]=useState<'demo'|'edge'|'cloud'|'offline cache'>('demo');
  const [category,setCategory]=useState('All items');
  const [search,setSearch]=useState('');
  const [orderType,setOrderType]=useState<'dine_in'|'takeaway'>('dine_in');
  const [table,setTable]=useState('Table 04');
  const [cart,setCart]=useState<CartLine[]>([]);
  const [note,setNote]=useState('');
  const [orders,setOrders]=useState<OrderRecord[]>([]);
  const [kitchenTickets,setKitchenTickets]=useState<KitchenOrder[]>([]);
  const [kitchenStationFilter,setKitchenStationFilter]=useState('All stations');
  const [editingOrderId,setEditingOrderId]=useState('');
  const [editCommandId,setEditCommandId]=useState('');
  const [outletContext,setOutletContext]=useState<EdgeContext|null>(readCachedContext);
  const [isOutletEdge,setIsOutletEdge]=useState(false);
  const [staffSession,setStaffSession]=useState<EdgeStaffSession|null>(null);
  const [staffSessionReady,setStaffSessionReady]=useState(false);
  const [taxRateBps,setTaxRateBps]=useState(0);
  const [queue,setQueue]=useState<QueuedOrder[]>([]);
  const [online,setOnline]=useState(navigator.onLine);
  const [connected,setConnected]=useState(false);
  const [connectionHelpOpen,setConnectionHelpOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [toast,setToast]=useState('');
  const [checkoutOpen,setCheckoutOpen]=useState(false);
  const [shiftOpen,setShiftOpen]=useState(false);
  const [shiftSummary,setShiftSummary]=useState<ShiftSummary|null>(null);
  const [syncStatus,setSyncStatus]=useState<SyncStatus|null>(null);
  const [shiftBusy,setShiftBusy]=useState(false);
  const [openingFloat,setOpeningFloat]=useState('500');
  const [countedCash,setCountedCash]=useState('');
  const [movementType,setMovementType]=useState<'cash_in'|'cash_out'>('cash_in');
  const [movementAmount,setMovementAmount]=useState('');
  const [movementReason,setMovementReason]=useState('');
  const [checkoutCommandId,setCheckoutCommandId]=useState('');
  const [paymentMethod,setPaymentMethod]=useState<PaymentMethod>('cash');
  const [splitPayment,setSplitPayment]=useState(false);
  const [splitAmount,setSplitAmount]=useState('');
  const [splitMethod,setSplitMethod]=useState<PaymentMethod>('upi');
  const [floorOpen,setFloorOpen]=useState(false);
  const [modifierItem,setModifierItem]=useState<MenuItem|null>(null);
  const [modifierSelection,setModifierSelection]=useState<string[]>([]);
  const [clock,setClock]=useState(new Date());

  const activeOrders=orders.filter(order=>['sent','preparing','ready'].includes(order.status));
  const editingOrder=activeOrders.find(order=>order.id===editingOrderId);
  const cartSubtotal=cart.reduce((sum,line)=>sum+(line.item.priceMinor+line.modifiers.reduce((amount,modifier)=>amount+modifier.priceDeltaMinor,0))*line.quantity,0);
  const subtotal=(editingOrder?.subtotalMinor??0)+cartSubtotal;
  const tax=editingOrder&&!cart.length?editingOrder.taxTotalMinor:Math.round(subtotal*taxRateBps/10000); // Demonstration rate only, must be configured for a real outlet.
  const total=editingOrder&&!cart.length?editingOrder.totalMinor:subtotal+tax;
  const displayItemCount=(editingOrder?.lines.filter(line=>!line.voidedAt).reduce((sum,line)=>sum+line.quantity,0)??0)+cart.reduce((sum,line)=>sum+line.quantity,0);
  const money=(minor:number)=>formatMoney(minor,outletContext?.currency??'INR');
  const filteredMenu=useMemo(()=>menu.filter(item=>(category==='All items'||item.category===category)&&(!search||item.name.toLowerCase().includes(search.toLowerCase()))),[menu,category,search]);
  const categories=useMemo(()=>['All items',...new Set(menu.map(item=>item.category))],[menu]);
  const pendingTickets:LocalTicket[]=queue.flatMap((entry,index)=>{
    const lines=entry.command.lines.flatMap(line=>{const item=menu.find(candidate=>candidate.id===line.menuItemId);const modifiers=item?.modifiers.filter(option=>line.modifierIds?.includes(option.id))??[];const unit=(item?.priceMinor??0)+modifiers.reduce((sum,option)=>sum+option.priceDeltaMinor,0);return item?[{id:`${entry.command.commandId}-${item.id}`,menuItemId:item.id,name:item.name,category:item.category,quantity:line.quantity,unitPriceMinor:unit,lineTotalMinor:unit*line.quantity,kitchenStation:item.kitchenStation,...(line.note?{note:line.note}:{}),modifiers}]:[];});
    return [...new Set(lines.map(line=>line.kitchenStation))].map(station=>({id:`${entry.command.commandId}-${station}`,ticketId:`${entry.command.commandId}-${station}`,kitchenStation:station,ticketStatus:'new' as const,orderNumber:`OFFLINE ${String(index+1).padStart(2,'0')}`,orderType:entry.command.orderType,tableLabel:entry.command.tableLabel??null,status:'sent' as const,note:entry.command.note??null,createdAt:entry.queuedAt,pending:true as const,lines:lines.filter(line=>line.kitchenStation===station)}));
  });
  const tickets:TicketView[]=[...pendingTickets,...kitchenTickets];
  const canUsePos=!staffSession||['owner','manager','cashier'].includes(staffSession.role);
  const canUseKitchen=!staffSession||['owner','manager','kitchen'].includes(staffSession.role);
  const canViewReports=!staffSession||['owner','manager','viewer'].includes(staffSession.role);
  const canManage=!staffSession||['owner','manager'].includes(staffSession.role);
  const staffName=staffSession?.displayName??'Outlet team';
  const staffInitials=staffName.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]?.toUpperCase()??'').join('')||'OT';
  const kitchenStations=['All stations',...new Set(tickets.map(ticket=>ticket.kitchenStation).filter((station):station is string=>Boolean(station)))];
  const visibleTickets=kitchenStationFilter==='All stations'?tickets:tickets.filter(ticket=>ticket.kitchenStation===kitchenStationFilter);

  const notify=useCallback((message:string)=>{setToast(message);window.setTimeout(()=>setToast(''),2600);},[]);
  const refreshQueue=useCallback(async()=>{try{setQueue(await listQueuedOrders());}catch{notify('This browser could not open its local offline queue.');}},[notify]);
  const refreshOrders=useCallback(async()=>{try{const response=await fetch('/api/orders');if(!response.ok)throw new Error();setOrders(await response.json() as OrderRecord[]);}catch{/* The cached client keeps rendering while the local edge server is unreachable. */}},[]);
  const refreshKitchen=useCallback(async()=>{try{const response=await fetch('/api/kitchen',{cache:'no-store'});if(!response.ok)throw new Error();setKitchenTickets(await response.json() as KitchenOrder[]);}catch{/* Preserve the last kitchen snapshot while reconnecting. */}},[]);
  const refreshShift=useCallback(async()=>{try{const response=await fetch('/api/shifts/current');if(!response.ok)throw new Error();const payload=await response.json() as {shift:ShiftSummary|null};setShiftSummary(payload.shift);}catch{/* Shift controls stay unavailable when the local edge is unreachable. */}},[]);
  const refreshSyncStatus=useCallback(async()=>{try{const response=await fetch('/api/sync/status');if(!response.ok)throw new Error();setSyncStatus(await response.json() as SyncStatus);}catch{setSyncStatus(null);}},[]);

  const flushQueue=useCallback(async()=>{
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
    void refreshQueue();void refreshOrders();void refreshKitchen();void refreshShift();void refreshSyncStatus();
    void (async()=>{
      let edgeContext:EdgeContext|null=null;
      try{
        const response=await fetch('/api/context',{cache:'no-store'});
        if(response.ok&&response.headers.get('content-type')?.includes('application/json')){
          const context=await response.json() as Partial<EdgeContext>;
          if(typeof context.tenantId==='string'&&typeof context.outletId==='string'&&typeof context.terminalId==='string')edgeContext=context as EdgeContext;
        }
      }catch{/* Vercel-hosted manager and the outlet edge expose different APIs. */}
      if(edgeContext){
        setIsOutletEdge(true);
        setOutletContext(edgeContext);setTaxRateBps(edgeContext.taxRateBps);
        try{localStorage.setItem(CONTEXT_CACHE,JSON.stringify(edgeContext));}catch{/* The current session can still work without caching outlet setup. */}
        try{
          const response=await fetch('/api/menu',{cache:'no-store'});
          if(response.ok){const rows=await response.json() as MenuItem[];if(Array.isArray(rows)){setMenu(rows);setMenuSource('edge');return;}}
        }catch{/* An offline cashier can use the last cloud cache while the edge menu is repaired. */}
      }

      const cloudContext=readCloudMenuContext();
      if(!cloudContext||!supabase)return;
      const cacheKey=`common-table.menu-cache.v1:${cloudContext.tenantId}:${cloudContext.outletId}`;
      const {data:sessionData}=await supabase.auth.getSession();
      const currentUserId=sessionData.session?.user.id;
      if(!currentUserId)return;
      try{const cached=localStorage.getItem(cacheKey);if(cached){const saved=JSON.parse(cached) as {userId?:string;items?:MenuItem[]};if(saved.userId===currentUserId&&Array.isArray(saved.items)&&saved.items.length){setMenu(saved.items);setMenuSource('offline cache');}}}catch{/* A bad or stale cache is ignored; the cloud request can repopulate it. */}
      if(!navigator.onLine)return;
      const {data:userData,error:userError}=await supabase.auth.getUser();
      if(userError||!userData.user||userData.user.id!==currentUserId)return;
      const [categoryResult,itemResult]=await Promise.all([
        supabase.from('menu_categories').select('category_id,name,active').eq('tenant_id',cloudContext.tenantId).eq('outlet_id',cloudContext.outletId).eq('active',true),
        supabase.from('menu_items').select('item_id,category_id,name,price_minor,emoji,color,tag,vegetarian,available,kitchen_station,modifiers').eq('tenant_id',cloudContext.tenantId).eq('outlet_id',cloudContext.outletId).eq('available',true).order('sort_order').order('name'),
      ]);
      if(categoryResult.error)throw categoryResult.error;
      if(itemResult.error)throw itemResult.error;
      const names=new Map((categoryResult.data??[]).map(row=>[row.category_id as string,row.name as string]));
      const rows=((itemResult.data??[]) as CloudMenuRow[]).map(row=>({
        id:row.item_id,name:row.name,category:names.get(row.category_id)??'Menu',priceMinor:Number(row.price_minor),emoji:row.emoji,color:row.color,
        ...(row.tag?{tag:row.tag}:{}),vegetarian:row.vegetarian,available:row.available,kitchenStation:row.kitchen_station,modifiers:Array.isArray(row.modifiers)?row.modifiers:[],
      } satisfies MenuItem));
      if(!rows.length)return;
      setMenu(rows);setMenuSource('cloud');
      try{localStorage.setItem(cacheKey,JSON.stringify({userId:currentUserId,items:rows}));}catch{/* Current session continues even when storage is full. */}
    })().catch(()=>undefined);
    const onOnline=()=>{setOnline(true);void flushQueue();};const onOffline=()=>setOnline(false);
    window.addEventListener('online',onOnline);window.addEventListener('offline',onOffline);
    const retry=window.setInterval(()=>{void flushQueue();void refreshOrders();void refreshKitchen();void refreshShift();void refreshSyncStatus();},5000);
    return()=>{window.removeEventListener('online',onOnline);window.removeEventListener('offline',onOffline);window.clearInterval(retry);};
  },[flushQueue,refreshKitchen,refreshOrders,refreshQueue,refreshShift,refreshSyncStatus]);

  useEffect(()=>{
    if(!isOutletEdge)return;
    let active=true;
    if(!supabase){
      void fetch('/api/auth/session',{cache:'no-store'}).then(async response=>{
        if(!response.ok)throw new Error('No local development session is available.');
        const next=await response.json() as EdgeStaffSession;
        if(active)setStaffSession(next);
      }).catch(()=>{if(active)setStaffSession(null);}).finally(()=>{if(active)setStaffSessionReady(true);});
      return()=>{active=false;};
    }
    const exchange=async(accessToken?:string)=>{
      if(accessToken&&navigator.onLine){
        const response=await fetch('/api/auth/session',{method:'POST',headers:{authorization:`Bearer ${accessToken}`},cache:'no-store'});
        if(response.ok){const next=await response.json() as EdgeStaffSession;if(active)setStaffSession(next);return true;}
      }
      const response=await fetch('/api/auth/session',{cache:'no-store'}).catch(()=>null);
      if(response?.ok){const next=await response.json() as EdgeStaffSession;if(active)setStaffSession(next);return true;}
      return false;
    };
    void (async()=>{
      try{
        const {data}=await supabase.auth.getSession();
        const established=await exchange(data.session?.access_token);
        if(active&&!established)setStaffSession(null);
      }catch{if(active)setStaffSession(null);}
      finally{if(active)setStaffSessionReady(true);}
    })();
    const {data:listener}=supabase.auth.onAuthStateChange((event,session)=>{
      window.setTimeout(()=>{
        if(event==='SIGNED_OUT'){
          void fetch('/api/auth/session',{method:'DELETE'});
          if(active)setStaffSession(null);
        }else if(session?.access_token){void exchange(session.access_token).catch(()=>undefined);}
      },0);
    });
    return()=>{active=false;listener.subscription.unsubscribe();};
  },[isOutletEdge]);

  useEffect(()=>{
    if(!isOutletEdge||!staffSession)return;
    if(staffSession.role==='kitchen')setPage('kitchen');
    else if(staffSession.role==='viewer')setPage('reports');
    void refreshOrders();void refreshKitchen();void refreshShift();void refreshSyncStatus();
  },[isOutletEdge,staffSession,refreshKitchen,refreshOrders,refreshShift,refreshSyncStatus]);

  useEffect(()=>{const timer=window.setInterval(()=>setClock(new Date()),30000);return()=>window.clearInterval(timer);},[]);

  useEffect(()=>{
    let socket:WebSocket|undefined;let retryTimer:number|undefined;let cancelled=false;let delay=700;
    const connect=()=>{
      // `navigator.onLine` tracks internet reachability, not the outlet LAN.
      // Keep trying the edge WebSocket while WAN is down so KDS stays live.
      if(cancelled)return;
      const address=new URL('/socket',window.location.href);address.protocol=address.protocol==='https:'?'wss:':'ws:';
      socket=new WebSocket(address);
      socket.onopen=()=>{setConnected(true);delay=700;};
      socket.onclose=()=>{setConnected(false);if(!cancelled){retryTimer=window.setTimeout(connect,delay);delay=Math.min(delay*1.7,10000);}};
      socket.onerror=()=>socket?.close();
      socket.onmessage=event=>{try{const message=JSON.parse(event.data) as ServerMessage;if(message.type==='kitchen.snapshot')setKitchenTickets(message.payload as KitchenOrder[]);if(message.type==='order.created'||message.type==='order.updated'){const order=message.payload as OrderRecord;setOrders(previous=>[order,...previous.filter(row=>row.id!==order.id)]);void refreshKitchen();}}catch{/* Ignore malformed socket frames and recover on the next snapshot. */}};
    };
    connect();return()=>{cancelled=true;window.clearTimeout(retryTimer);socket?.close();};
  },[refreshKitchen]);

  function addItem(item:MenuItem){if(item.modifiers.length){setModifierItem(item);setModifierSelection(item.modifiers.filter(option=>option.group!=='Add-on'&&item.modifiers.find(candidate=>candidate.group===option.group)?.id===option.id).map(option=>option.id));return;}addConfiguredItem(item,[]);}
  function addConfiguredItem(item:MenuItem,modifierIds:string[]){if(editingOrder)setEditCommandId(makeId());const modifiers=item.modifiers.filter(option=>modifierIds.includes(option.id));setCart(previous=>{const signature=modifierIds.slice().sort().join('|');const found=previous.find(line=>line.item.id===item.id&&line.modifiers.map(option=>option.id).sort().join('|')===signature);return found?previous.map(line=>line.id===found.id?{...line,quantity:line.quantity+1}:line):[...previous,{id:makeId(),item,quantity:1,modifiers}];});}
  function toggleModifier(option:ModifierOption){setModifierSelection(previous=>option.group==='Add-on'?(previous.includes(option.id)?previous.filter(id=>id!==option.id):[...previous,option.id]):[...previous.filter(id=>!modifierItem?.modifiers.some(candidate=>candidate.id===id&&candidate.group===option.group)),option.id]);}
  function changeQuantity(lineId:string,direction:number){if(editingOrder)setEditCommandId(makeId());setCart(previous=>previous.flatMap(line=>line.id!==lineId?[line]:line.quantity+direction<=0?[]:[{...line,quantity:line.quantity+direction}]));}
  function buildCommand(commandId:string=makeId()):CreateOrderCommand{
    if(!outletContext)throw new Error('This device has not loaded outlet setup from the local edge server.');
    return {commandId,tenantId:outletContext.tenantId,outletId:outletContext.outletId,terminalId:outletContext.terminalId,orderType,...(orderType==='dine_in'?{tableLabel:table}:{}),guestCount:2,...(note?{note}:{}),lines:cart.map(line=>({menuItemId:line.item.id,quantity:line.quantity,modifierIds:line.modifiers.map(option=>option.id)}))};
  }

  async function sendToKitchen(){
    if(!cart.length||busy)return;if(!outletContext){notify('Connect to the outlet edge server before sending or queueing an order.');return;}setBusy(true);const command=editingOrder?null:buildCommand();
    try{
      const response=editingOrder
        ?await fetch(`/api/orders/${editingOrder.id}/lines`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:editCommandId||makeId(),lines:cart.map(line=>({menuItemId:line.item.id,quantity:line.quantity,modifierIds:line.modifiers.map(option=>option.id)}))})})
        :await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
      if(!response.ok){if(response.status<500){const problem=await response.json().catch(()=>({}));if(editingOrder)setEditCommandId(makeId());notify(problem.error??'The edge server rejected this order.');setBusy(false);return;}throw new Error('Could not save the order on the edge server.');}
      const order=await response.json() as OrderRecord;setOrders(previous=>[order,...previous.filter(row=>row.id!==order.id)]);if(editingOrder)setEditCommandId(makeId());notify(editingOrder?`Items added to ${order.orderNumber}`:`${order.orderNumber} sent to kitchen`);
    }catch{
      if(!command){notify('Could not reach the outlet edge to add these items. Reconnect and retry.');setBusy(false);return;}
      try{await queueOrder(command);await refreshQueue();notify('Order saved locally. It will sync when the edge server reconnects.');}
      catch{notify('Could not save this order offline. Check browser storage permissions.');setBusy(false);return;}
    }
    setCart([]);setNote('');setBusy(false);
  }

  async function voidOrderLine(orderId:string,line:OrderLine){
    if(!connected)return;const reason=window.prompt(`Why are you voiding ${line.name}?`);if(!reason?.trim())return;
    try{const response=await fetch(`/api/orders/${orderId}/lines/${line.id}/void`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:makeId(),reason:reason.trim()})});const payload=await response.json() as OrderRecord|{error?:string};if(!response.ok)throw new Error('error'in payload?payload.error:'Could not void this item.');const updated=payload as OrderRecord;setOrders(previous=>[updated,...previous.filter(row=>row.id!==updated.id)]);notify(`Voided ${line.name} · reason recorded`);}
    catch(error){notify(error instanceof Error?error.message:'Could not void this item.');}
  }
  async function voidWholeOrder(order:TicketView){
    if(!connected||order.pending)return;const reason=window.prompt(`Why are you voiding order ${order.orderNumber}?`);if(!reason?.trim())return;
    try{const response=await fetch(`/api/orders/${order.id}/void`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:makeId(),reason:reason.trim()})});const payload=await response.json() as OrderRecord|{error?:string};if(!response.ok)throw new Error('error'in payload?payload.error:'Could not void this order.');const updated=payload as OrderRecord;setOrders(previous=>[updated,...previous.filter(row=>row.id!==updated.id)]);notify(`Order ${order.orderNumber} voided · reason recorded`);}
    catch(error){notify(error instanceof Error?error.message:'Could not void this order.');}
  }

  async function recordPayment(){
    if((!cart.length&&!editingOrder)||busy)return;if(!outletContext||!connected){notify('Connect this browser to the outlet edge server before taking payment.');return;}if(!shiftSummary||shiftSummary.shift.status!=='open'){setCheckoutOpen(false);setShiftOpen(true);notify('Open a shift before recording a tender.');return;}
    const splitMinor=Math.round(Number(splitAmount)*100);
    if(splitPayment&&(!Number.isSafeInteger(splitMinor)||splitMinor<=0||splitMinor>=total||splitMethod===paymentMethod)){
      notify(splitMethod===paymentMethod?'Choose two different tender methods.':'Enter a split amount smaller than the order total.');return;
    }
    setBusy(true);
    try{
      let order:OrderRecord;
      if(editingOrder){
        order=editingOrder;
        if(cart.length){
          const additionsResponse=await fetch(`/api/orders/${editingOrder.id}/lines`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:editCommandId||makeId(),lines:cart.map(line=>({menuItemId:line.item.id,quantity:line.quantity,modifierIds:line.modifiers.map(option=>option.id)}))})});
          const additionsPayload=await additionsResponse.json() as OrderRecord|{error?:string};
          if(!additionsResponse.ok)throw new Error('error'in additionsPayload?additionsPayload.error??'Could not add these items before payment.':'Could not add these items before payment.');
          order=additionsPayload as OrderRecord;
          setOrders(previous=>[order,...previous.filter(row=>row.id!==order.id)]);
          setCart([]);setEditCommandId(makeId());
        }
      }else{
        const createResponse=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(buildCommand(checkoutCommandId))});
        if(!createResponse.ok)throw new Error();
        order=await createResponse.json() as OrderRecord;
      }
      if(splitPayment&&(!Number.isSafeInteger(splitMinor)||splitMinor<=0||splitMinor>=order.totalMinor||splitMethod===paymentMethod)){
        notify(splitMethod===paymentMethod?'Choose two different tender methods.':'Enter a split amount smaller than the order total.');setBusy(false);return;
      }
      const payment:PaymentCommand={commandId:makeId(),orderId:order.id,shiftId:shiftSummary.shift.id,
        tenders:splitPayment?[{method:paymentMethod,amountMinor:order.totalMinor-splitMinor},{method:splitMethod,amountMinor:splitMinor}]:[{method:paymentMethod,amountMinor:order.totalMinor}]};
      const response=await fetch(`/api/orders/${order.id}/payment`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payment)});
      if(!response.ok){const result=await response.json() as {error?:string};throw new Error(result.error??'Could not record payment.');}const paid=await response.json() as OrderRecord;setOrders(previous=>[paid,...previous.filter(row=>row.id!==paid.id)]);setCheckoutOpen(false);setCart([]);setNote('');setEditingOrderId('');setEditCommandId('');setSplitPayment(false);setSplitAmount('');notify(`Demo payment recorded · ${paid.invoiceNumber}`);
    }catch(error){notify(error instanceof Error?error.message:'Payment needs the edge server. This prototype does not process real payments.');}
    setBusy(false);
  }

  async function openShift(){
    if(!connected){notify('Connect this browser to the outlet edge server before managing shifts.');return;}
    const amount=Math.round(Number(openingFloat)*100);if(!Number.isSafeInteger(amount)||amount<0){notify('Enter a valid opening float.');return;}setShiftBusy(true);
    try{const response=await fetch('/api/shifts/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:makeId(),openingFloatMinor:amount})});const payload=await response.json() as ShiftSummary|{error?:string};if(!response.ok)throw new Error('error'in payload?payload.error:'Could not open the shift.');setShiftSummary(payload as ShiftSummary);setCountedCash(((payload as ShiftSummary).expectedCashMinor/100).toFixed(2));notify(`Shift ${(payload as ShiftSummary).shift.shiftNumber} opened.`);}
    catch(error){notify(error instanceof Error?error.message:'Could not open the shift.');}finally{setShiftBusy(false);}
  }

  async function recordCashMovement(){
    if(!connected){notify('Reconnect to the outlet edge server before recording cash movement.');return;}
    if(!shiftSummary||shiftSummary.shift.status!=='open')return;const amount=Math.round(Number(movementAmount)*100);if(!Number.isSafeInteger(amount)||amount<=0||movementReason.trim().length<3){notify('Enter an amount and a reason (at least 3 characters).');return;}setShiftBusy(true);
    try{const response=await fetch(`/api/shifts/${shiftSummary.shift.id}/cash-movements`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:makeId(),type:movementType,amountMinor:amount,reason:movementReason.trim()})});const payload=await response.json() as ShiftSummary|{error?:string};if(!response.ok)throw new Error('error'in payload?payload.error:'Could not record cash movement.');setShiftSummary(payload as ShiftSummary);setCountedCash(((payload as ShiftSummary).expectedCashMinor/100).toFixed(2));setMovementAmount('');setMovementReason('');notify('Cash movement recorded.');}
    catch(error){notify(error instanceof Error?error.message:'Could not record cash movement.');}finally{setShiftBusy(false);}
  }

  async function closeShift(){
    if(!connected){notify('Reconnect to the outlet edge server before closing the shift.');return;}
    if(!shiftSummary)return;const amount=Math.round(Number(countedCash)*100);if(!Number.isSafeInteger(amount)||amount<0){notify('Enter a valid counted cash amount.');return;}setShiftBusy(true);
    try{const response=await fetch(`/api/shifts/${shiftSummary.shift.id}/close`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:makeId(),countedCashMinor:amount})});const payload=await response.json() as ShiftSummary|{error?:string};if(!response.ok)throw new Error('error'in payload?payload.error:'Could not close the shift.');setShiftSummary(payload as ShiftSummary);const variance=(payload as ShiftSummary).shift.varianceMinor??0;notify(`Shift closed · ${variance===0?'cash balanced':`variance ${money(variance)}`}`);}
    catch(error){notify(error instanceof Error?error.message:'Could not close the shift.');}finally{setShiftBusy(false);}
  }

  async function updateTicket(ticket:TicketView,next:'preparing'|'ready'){
    if(ticket.pending){notify('This offline ticket will sync before kitchen status updates.');return;}
    if(!ticket.kitchenStation){notify('This ticket has no kitchen station. Refresh the kitchen display.');return;}
    try{const response=await fetch(`/api/orders/${ticket.id}/stations/${encodeURIComponent(ticket.kitchenStation)}/status`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:next})});const payload=await response.json() as {error?:string};if(!response.ok)throw new Error(payload.error??'Could not update the kitchen ticket.');await refreshKitchen();}
    catch{notify('Could not update the kitchen ticket.');}
  }

  async function testPrinter(){try{const response=await fetch('/api/printer/test',{method:'POST'});if(!response.ok)throw new Error();notify('Test ticket sent to the mock printer socket.');}catch{notify('Mock printer is not connected.');}}

  if(isOutletEdge&&(!staffSessionReady||!staffSession))return <main className="grid min-h-screen place-items-center bg-[#f5f7f5] p-5"><section className="w-full max-w-md rounded-3xl border border-[#e1e8e1] bg-white p-8 shadow-sm"><div className="grid size-12 place-items-center rounded-2xl bg-[#edf5ee] font-bold text-[#317452]">ct</div><h1 className="mt-5 text-2xl font-bold text-[#263b30]">Sign in to this outlet</h1><p className="mt-2 text-sm leading-6 text-[#718077]">Use your Common Table staff account on this device. The outlet edge keeps the session available through temporary internet loss.</p>{staffSessionReady&&!supabase&&<p className="mt-4 rounded-xl bg-[#fff4f1] p-3 text-sm text-[#9a493d]">Supabase Auth is not configured on this outlet edge.</p>}<a className="mt-6 flex h-11 items-center justify-center rounded-xl bg-[#286a4f] text-sm font-semibold text-white" href="/admin">Continue to staff sign in</a><button onClick={()=>window.location.reload()} className="mt-3 h-10 w-full rounded-xl border border-[#dfe6df] text-sm font-semibold text-[#526259]">Check session again</button></section></main>;

  return <div className="flex min-h-screen bg-[#f5f7f5] text-[#192522]">
    <aside className="hidden w-[236px] shrink-0 flex-col border-r border-[#e7ece8] bg-[#fbfcfa] px-3 py-5 md:flex">
      <div className="mb-6 flex items-center gap-2.5 px-2"><div className="grid size-9 place-items-center rounded-xl bg-[#28694f] font-extrabold tracking-[-2px] text-[#fff6e5]">ct</div><div><strong className="block text-[13px] font-extrabold tracking-[-.4px]">common table</strong><span className="text-[9px] uppercase tracking-[.7px] text-[#89968f]">restaurant OS</span></div></div>
      <button onClick={()=>setConnectionHelpOpen(true)} aria-haspopup="dialog" className="mb-6 flex items-center gap-2 rounded-xl border border-[#e6ece7] bg-[#f1f5f1] px-2.5 py-2 text-left"><span className="grid size-8 place-items-center rounded-lg bg-white text-[#34704f]">⌂</span><span className="min-w-0 flex-1"><strong className="block truncate text-[10px]">{outletContext?.locationLabel??'Outlet not connected'}</strong><small className="text-[9px] text-[#87948d]">{outletContext?.outletName??'How to connect the local edge'}</small></span><ChevronDown size={14} className="text-[#89958f]" /></button>
      <p className="mb-2 px-2 text-[9px] font-bold tracking-[1px] text-[#9aa49e]">WORKSPACE</p>
      <nav className="space-y-1">
        {canUsePos&&<button onClick={()=>setPage('pos')} className={`flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[11px] ${page==='pos'?'bg-[#e9f4ed] font-bold text-[#27694f]':'text-[#718078] hover:bg-[#f1f5f1]'}`}><LayoutGrid size={16} />Point of sale <span className="ml-auto text-[9px] opacity-60">1</span></button>}
        {canUseKitchen&&<button onClick={()=>setPage('kitchen')} className={`flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[11px] ${page==='kitchen'?'bg-[#e9f4ed] font-bold text-[#27694f]':'text-[#718078] hover:bg-[#f1f5f1]'}`}><ChefHat size={16} />Kitchen display{tickets.length>0&&<span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[9px]">{tickets.length}</span>}</button>}
        {canViewReports&&<button onClick={()=>setPage('reports')} className={`flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[11px] ${page==='reports'?'bg-[#e9f4ed] font-bold text-[#27694f]':'text-[#718078] hover:bg-[#f1f5f1]'}`}><BarChart3 size={16}/>Daily reports</button>}
      </nav>
      <div className="mt-auto">
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-[#f1f6f1] p-2.5"><span className={`mt-1 size-2 rounded-full ${connected?'bg-[#54a474]':'bg-[#d79543]'}`} /><span><strong className="block text-[9px]">{connected?'Edge server connected':isOutletEdge?online?'Edge connection retrying':'Outlet network unavailable':'Preview · no outlet edge'}</strong><small className="text-[8px] text-[#87948d]">{queue.length?`${queue.length} order${queue.length===1?'':'s'} awaiting sync`:isOutletEdge?'Orders saved on this device':'Preview mode · orders are not saved'}</small></span></div>
        <div className="flex items-center gap-2 border-t border-[#e8ede9] px-1 pt-3"><span className="grid size-8 place-items-center rounded-full bg-[#f2ddce] text-[9px] font-bold text-[#80513d]">{staffInitials}</span><span className="min-w-0"><strong className="block truncate text-[10px]">{staffName}</strong><small className="text-[9px] capitalize text-[#89958e]">{staffSession?.role??'local owner'}</small></span><MoreHorizontal size={16} className="ml-auto text-[#92a098]" /></div>
      </div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[58px] items-center justify-between border-b border-[#e7ece8] bg-white/70 px-4 md:px-8">
        <div className="flex items-center gap-2 text-[10px] text-[#89958f]"><span className="md:hidden font-bold text-[#28694f]">ct</span><span>{outletContext?.outletName??'Common Table POS'}</span><span className="text-[#c3cbc6]">/</span><strong className="font-semibold text-[#405149]">{page==='pos'?'Point of sale':page==='kitchen'?'Kitchen display':'Daily reports'}</strong></div>
        <div className="flex items-center gap-2 sm:gap-4"><span title={syncStatus?.lastError??(syncStatus?.lastSyncedAt?`Last cloud sync ${new Date(syncStatus.lastSyncedAt).toLocaleString('en-IN')}`:'Sync state from the outlet edge')} className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[9px] sm:flex ${!syncStatus?.configured?'border-[#e6ebe7] text-[#78857d]':syncStatus.failed?'border-[#f0d9d2] bg-[#fff6f3] text-[#a34f3d]':syncStatus.pending?'border-[#f0e2c9] bg-[#fffaf1] text-[#9a6c2b]':'border-[#dce9df] bg-[#f5faf6] text-[#467652]'}`}><i className={`size-1.5 rounded-full ${!syncStatus?.configured?'bg-[#a4ada7]':syncStatus.failed?'bg-[#c66955]':syncStatus.pending?'bg-[#d69b45]':'bg-[#55a877]'}`} />{!syncStatus?'Sync status':!syncStatus.configured?'Sync not configured':syncStatus.failed?`${syncStatus.failed} failed`:syncStatus.pending?`${syncStatus.pending} queued`:syncStatus.lastSyncedAt?'Queue clear':'Sync ready'}</span><button onClick={()=>setShiftOpen(true)} aria-haspopup="dialog" className="flex items-center gap-2 rounded-full border border-[#e6ebe7] px-2.5 py-1.5 text-[9px] text-[#65736c]"><i className={`size-1.5 rounded-full ${shiftSummary?.shift.status==='open'?'bg-[#55a877]':'bg-[#d79543]'}`} />{shiftSummary?.shift.status==='open'?shiftSummary.shift.shiftNumber:'No shift open'}</button><button disabled={!isOutletEdge} onClick={testPrinter} title={isOutletEdge?'Send test to mock printer':'Connect to the outlet edge to test the printer'} className="grid size-7 place-items-center rounded-full border border-[#e6ebe7] bg-white text-[#7d8983] disabled:cursor-not-allowed disabled:opacity-40"><Printer size={13}/></button><button title="Help" className="grid size-7 place-items-center rounded-full border border-[#e6ebe7] bg-white text-[#7d8983]"><CircleHelp size={13}/></button><div className="text-right text-[8px] tracking-[.6px] text-[#97a19b]">{clock.toLocaleDateString('en-IN',{weekday:'short',month:'short',day:'2-digit'}).toUpperCase()} <strong className="block text-[10px] tracking-normal text-[#42534b]">{clock.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</strong></div></div>
      </header>

      {page==='pos'?<section className="mx-auto w-full max-w-[1540px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
        <div className="mb-5 flex items-end justify-between gap-3"><div><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">{clock.toLocaleDateString('en-IN',{weekday:'long'}).toUpperCase()} SERVICE <span className={`ml-1.5 ${isOutletEdge?'text-[#46805e]':'text-[#a77735]'}`}>● {isOutletEdge?'LIVE':'EDGE REQUIRED'}</span></p><h1 className="font-[Manrope,Inter,sans-serif] text-[23px] font-bold tracking-[-1px] text-[#24312c] sm:text-[26px]">Good morning, {staffName.split(/\s+/)[0]} <span className="text-[#d3974e]">✳</span></h1><p className="mt-1 text-[10px] text-[#8a9690]">A little more coffee, a little less waiting.</p></div><button onClick={()=>{if(cart.length)notify('Send or charge this order before starting a new one.');else{setEditingOrderId('');setEditCommandId('');setNote('');notify('New order ready.');}}} className="hidden h-9 items-center gap-2 rounded-lg border border-[#dfe6e1] bg-white px-3 text-[10px] font-bold text-[#40564b] sm:flex"><Plus size={14}/>New order</button></div>

        <div className="grid items-start gap-3 xl:grid-cols-[minmax(500px,1.55fr)_minmax(330px,.85fr)]">
          <section className="overflow-hidden rounded-[14px] border border-[#e8ede9] bg-white shadow-[0_10px_24px_rgba(25,37,34,.045)]">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#edf0ed] p-3">
              <div className="flex rounded-lg bg-[#f2f5f2] p-[3px]"><button disabled={!!editingOrder} onClick={()=>setOrderType('dine_in')} className={`rounded-md px-2.5 py-1.5 text-[9px] disabled:opacity-40 ${orderType==='dine_in'?'bg-white font-bold text-[#28694f] shadow-sm':'text-[#829089]'}`}>▤ Dine in</button><button disabled={!!editingOrder} onClick={()=>setOrderType('takeaway')} className={`rounded-md px-2.5 py-1.5 text-[9px] disabled:opacity-40 ${orderType==='takeaway'?'bg-white font-bold text-[#28694f] shadow-sm':'text-[#829089]'}`}>↗ Takeaway</button></div>
              {orderType==='dine_in'&&<><label className="flex h-[31px] items-center gap-2 rounded-lg border border-[#e8ede9] px-2 text-[9px] text-[#89948e]">Table<select disabled={!!editingOrder} value={table} onChange={event=>setTable(event.target.value)} className="appearance-none bg-transparent pr-1 text-[10px] font-semibold text-[#38483f]"><option>Table 04</option><option>Table 01</option><option>Table 02</option><option>Table 03</option><option>Table 05</option><option>Patio 01</option><option>Bar 01</option><option>Bar 02</option></select><ChevronDown size={12}/></label><button disabled={!!editingOrder} onClick={()=>setFloorOpen(true)} className="flex h-[31px] items-center gap-1 rounded-lg border border-[#e8ede9] px-2 text-[9px] font-semibold text-[#4b6657] disabled:opacity-40"><MapPin size={12}/>Floor plan</button></>}
              {orderType==='dine_in'&&<span className="ml-auto flex items-center gap-1.5 rounded-md bg-[#f7f9f7] px-2 py-2 text-[9px] text-[#78847e]">♙ 2 guests <ChevronDown size={12}/></span>}
            </div>
            <div className="flex items-center gap-2 border-b border-[#edf0ed] px-3 py-2"><span className="shrink-0 text-[8px] font-semibold text-[#829089]">Order</span><select aria-label="Add items to an open order" value={editingOrderId} onChange={event=>{const selected=activeOrders.find(order=>order.id===event.target.value);setEditingOrderId(event.target.value);setEditCommandId(selected?makeId():'');setCart([]);setNote(selected?.note??'');if(selected){setOrderType(selected.orderType);if(selected.tableLabel)setTable(selected.tableLabel);}}} className="h-8 min-w-0 flex-1 rounded-md border border-[#e8ede9] bg-white px-2 text-[9px] text-[#415148]"><option value="">New order</option>{activeOrders.map(order=><option key={order.id} value={order.id}>{order.orderNumber} · {order.orderType==='dine_in'?order.tableLabel:'Takeaway'} · {order.status}</option>)}</select>{editingOrder&&<button onClick={()=>{setEditingOrderId('');setEditCommandId('');setCart([]);setNote('');}} className="text-[8px] font-semibold text-[#6e8b79]">Clear</button>}</div>
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-4"><div><h2 className="text-[14px] font-bold tracking-[-.3px]">Menu</h2><span className="text-[9px] text-[#98a29d]">Find something good</span></div><label className="flex h-[31px] w-[min(190px,48%)] items-center gap-1.5 rounded-lg border border-[#e8ede9] px-2 text-[#8c9891]"><Search size={14}/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search menu" className="w-full min-w-0 border-0 bg-transparent text-[9px] text-[#324239] outline-none placeholder:text-[#a4aea8]"/><kbd className="hidden rounded border border-[#e8ede9] px-1 text-[8px] sm:block">⌘K</kbd></label></div>
            <div className="flex gap-1.5 overflow-x-auto px-4 pb-3">{categories.map(value=><button key={value} onClick={()=>setCategory(value)} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-[9px] ${category===value?'border-[#294f3f] bg-[#294f3f] text-white':'border-[#e8ede9] bg-white text-[#7e8a84]'}`}>{value}</button>)}</div>
            <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-3 2xl:grid-cols-4">{filteredMenu.map(item=><button key={item.id} onClick={()=>addItem(item)} className="group min-w-0 rounded-[11px] border border-[#edf0ed] bg-white p-2 text-left transition hover:-translate-y-0.5 hover:border-[#b7d4c3] hover:shadow-sm"><span className="relative mb-2 flex h-[70px] items-center justify-center overflow-hidden rounded-lg text-[31px]" style={{backgroundColor:item.color}}>{item.emoji}{item.vegetarian&&<i title="Vegetarian" className="absolute right-1.5 top-1.5 size-3 rounded-[2px] border border-[#438b52] after:mx-auto after:mt-[3px] after:block after:size-[5px] after:rounded-full after:bg-[#438b52] after:content-['']"/>}</span><span className="flex min-h-[26px] items-start justify-between gap-1"><strong className="text-[10px] font-semibold leading-[1.3] text-[#35443d]">{item.name}</strong>{item.tag&&<small className="shrink-0 rounded bg-[#fbf3e7] px-1 py-0.5 text-[6px] font-semibold tracking-[.3px] text-[#a07038]">{item.tag}</small>}</span><span className="mt-2 flex items-center justify-between"><strong className="text-[10px] text-[#2a3d33]">{money(item.priceMinor)}</strong><span className="grid size-[19px] place-items-center rounded-md bg-[#eef5ef] text-[14px] text-[#367252]">+</span></span></button>)}</div>
            <div className="border-t border-[#f0f2f0] px-4 py-2.5 text-[8px] text-[#98a29d]">Tap an item to add it to the order <span className="float-right">Prices in {outletContext?.currency??'INR'}</span></div>
          </section>

          <aside className="flex min-h-[510px] flex-col rounded-[14px] border border-[#e8ede9] bg-white p-3.5 shadow-[0_10px_24px_rgba(25,37,34,.045)] xl:sticky xl:top-3">
            <div className="flex items-center justify-between"><div><p className="mb-1 text-[8px] font-bold tracking-[1px] text-[#89958f]">{editingOrder?'OPEN ORDER':'CURRENT ORDER'}</p><h2 className="text-[14px] font-bold">{editingOrder?editingOrder.orderNumber:orderType==='dine_in'?table:'Takeaway'} <span className="font-normal text-[#9ba59f]">· {editingOrder?editingOrder.status:'New'}</span></h2></div><button className="text-[#8c9891]" aria-label="Order options"><MoreHorizontal size={18}/></button></div>
            <div className="mt-2.5 flex items-center gap-1.5 text-[8px] text-[#9aa49e]"><span className="rounded bg-[#eaf4ed] px-1.5 py-1 text-[7px] font-bold tracking-[.4px] text-[#36714f]">{(editingOrder?.orderType??orderType).toUpperCase().replace('_',' ')}</span><span>{editingOrder?new Date(editingOrder.createdAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'Started just now'}</span><span>·</span><span>{staffName}</span></div>
            <div className="min-h-[130px] flex-1 overflow-auto py-2">
              {editingOrder?.lines.map(line=><div key={`saved-${line.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-[#f0f2f0] py-2.5"><div className="min-w-0"><strong className={`block text-[10px] font-semibold ${line.voidedAt?'text-[#9aa49e] line-through':'text-[#36453e]'}`}>{line.name}</strong><small className="mt-1 block text-[8px] text-[#9aa49f]">{line.voidedAt?`Voided · ${line.voidReason??'reason recorded'}`:`On kitchen ticket · ${line.quantity} × ${money(line.unitPriceMinor)}`}</small>{!line.voidedAt&&line.modifiers.map(modifier=><small key={modifier.id} className="mt-0.5 block text-[8px] text-[#718078]">↳ {modifier.name}{modifier.priceDeltaMinor?` +${money(modifier.priceDeltaMinor)}`:''}</small>)}</div><strong className={`text-right text-[9px] ${line.voidedAt?'text-[#9aa49e] line-through':'text-[#405149]'}`}>{money(line.lineTotalMinor)}</strong></div>)}
              {cart.map(line=>{const unit=line.item.priceMinor+line.modifiers.reduce((sum,modifier)=>sum+modifier.priceDeltaMinor,0);return <div key={line.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-[#f0f2f0] py-2.5"><div className="min-w-0"><strong className="block text-[10px] font-semibold text-[#36453e]">{line.item.name}</strong><small className="mt-1 block text-[8px] text-[#9aa49f]">{editingOrder?'Add to ticket':line.item.category} · {money(unit)} each</small>{line.modifiers.map(modifier=><small key={modifier.id} className="mt-0.5 block text-[8px] text-[#718078]">↳ {modifier.name}{modifier.priceDeltaMinor?` +${money(modifier.priceDeltaMinor)}`:''}</small>)}</div><div className="flex items-center gap-1.5"><div className="flex items-center gap-1 rounded-md border border-[#edf0ed] px-1.5 py-1"><button onClick={()=>changeQuantity(line.id,-1)} aria-label="Decrease quantity" className="text-[#65756c]"><Minus size={11}/></button><span className="min-w-3 text-center text-[9px]">{line.quantity}</span><button onClick={()=>changeQuantity(line.id,1)} aria-label="Increase quantity" className="text-[#65756c]"><Plus size={11}/></button></div><strong className="min-w-[49px] text-right text-[9px]">{money(unit*line.quantity)}</strong><button onClick={()=>changeQuantity(line.id,-line.quantity)} aria-label="Remove item" className="text-[#c09b92]"><Trash2 size={12}/></button></div></div>;})}
              {!editingOrder?.lines.length&&!cart.length&&<div className="flex h-[150px] flex-col items-center justify-center gap-1.5 text-center"><Coffee size={27} className="mb-1 text-[#d7e2d9]"/><strong className="text-[10px] text-[#65746c]">Your order starts here</strong><span className="text-[9px] text-[#9aa59f]">Choose a favorite from the menu.</span></div>}
            </div>
            {editingOrder?.note&&<p className="mb-2 rounded bg-[#fff8ed] p-2 text-[8px] text-[#a17a48]">Kitchen note: {editingOrder.note}</p>}
            <label className="mb-2 flex h-8 items-center gap-1.5 rounded-md border border-dashed border-[#dce5de] px-2 text-[#7d9385]"><Plus size={13}/><input disabled={!!editingOrder} value={editingOrder?editingOrder.note??'':note} onChange={event=>setNote(event.target.value)} maxLength={140} placeholder={editingOrder?'Kitchen note is saved with the order':'Add a note for the kitchen'} className="w-full bg-transparent text-[9px] text-[#324239] outline-none placeholder:text-[#9ca8a1] disabled:cursor-not-allowed"/></label>
            <div className="border-t border-[#edf0ed] pt-2.5"><div className="mb-2 flex justify-between text-[9px] text-[#87938c]"><span>Subtotal</span><span>{money(subtotal)}</span></div><div className="mb-2 flex justify-between text-[9px] text-[#87938c]"><span>Tax <span className="text-[8px] text-[#a4aea8]">(demo {taxRateBps/100}%)</span></span><span>{money(tax)}</span></div><div className="flex items-center justify-between border-t border-dashed border-[#e6ebe7] pt-2.5"><strong className="text-[11px]">Total</strong><strong className="text-[17px] tracking-[-.4px]">{money(total)}</strong></div><p className="mt-1.5 text-[8px] text-[#a2aaa5]">Sample tax only. Set local rules before live use.</p></div>
            <div className="mt-3 grid grid-cols-2 gap-2"><button disabled={!cart.length||busy} onClick={()=>void sendToKitchen()} className="flex h-10 items-center justify-center gap-1.5 rounded-lg border border-[#dfe8e1] bg-white text-[9px] font-bold text-[#43624f] disabled:cursor-not-allowed disabled:opacity-40"><Send size={13}/>{busy?<LoaderCircle size={12} className="animate-spin"/>:editingOrder?'Send additions':'Send to kitchen'}</button><button disabled={(!cart.length&&(!editingOrder||editingOrder.totalMinor<=0))||busy} onClick={()=>{setCheckoutCommandId(makeId());setCheckoutOpen(true);}} className="flex h-10 items-center gap-1.5 rounded-lg bg-[#27694f] px-2 text-[9px] font-bold text-white hover:bg-[#1d503c] disabled:cursor-not-allowed disabled:opacity-40"><span>Charge</span><strong className="ml-auto text-[10px]">{money(total)}</strong><span>→</span></button></div>
            <div className="mt-2.5 text-center text-[8px] text-[#a0aaa4]">{isOutletEdge?'⌁ Orders save to this outlet edge before syncing to cloud':'⌁ Preview menu only · connect an outlet edge to save orders'}</div>
          </aside>
        </div>
      </section>:page==='kitchen'?<section className="mx-auto w-full max-w-[1540px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
        <div className="mb-5 flex items-end justify-between"><div><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">{isOutletEdge?(outletContext?.outletName??'OUTLET KITCHEN').toUpperCase():'TRAINING KITCHEN'} <span className={`ml-1.5 ${isOutletEdge?'text-[#46805e]':'text-[#a77735]'}`}>● {isOutletEdge?'LIVE BOARD':'EDGE REQUIRED'}</span></p><h1 className="text-[23px] font-bold tracking-[-1px] sm:text-[26px]">Kitchen display <span className="text-[#d3974e]">♨</span></h1><p className="mt-1 text-[10px] text-[#8a9690]">Keep the good stuff moving.</p></div><button disabled={!isOutletEdge} title={isOutletEdge?'Send a test ticket to the outlet printer':'Connect to the outlet edge to test the printer'} onClick={testPrinter} className="flex h-9 items-center gap-2 rounded-lg border border-[#dfe6e1] bg-white px-3 text-[9px] font-bold text-[#40564b] disabled:cursor-not-allowed disabled:opacity-50"><Printer size={13}/>Test printer</button></div>
        <div className="mb-3 flex items-center gap-4 rounded-lg border border-[#e8ede9] bg-white p-3 text-[9px] text-[#758179]"><span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-[#eaa64c]"/>In progress <strong className="text-[#34443c]">{tickets.filter(ticket=>ticketStatus(ticket)==='new'||ticketStatus(ticket)==='preparing').length}</strong></span><span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-[#5eaa7a]"/>Ready to serve <strong className="text-[#34443c]">{tickets.filter(ticket=>ticketStatus(ticket)==='ready').length}</strong></span><span className="ml-auto hidden text-[8px] text-[#a1aaa5] sm:block">{connected?'Connected · Live updates on':'Waiting for edge connection'}</span></div>
        <div className="mb-3 flex gap-2 overflow-x-auto">{kitchenStations.map(station=><button key={station} onClick={()=>setKitchenStationFilter(station)} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-[9px] ${kitchenStationFilter===station?'border-[#294f3f] bg-[#294f3f] text-white':'border-[#e8ede9] bg-white text-[#7e8a84]'}`}>{station}{station!=='All stations'&&<span className="ml-1.5 opacity-70">{tickets.filter(ticket=>ticket.kitchenStation===station).length}</span>}</button>)}</div>
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{visibleTickets.map(ticket=><article key={ticket.ticketId??ticket.id} className="overflow-hidden rounded-xl border border-[#e7ece8] bg-white shadow-[0_10px_24px_rgba(25,37,34,.045)]"><header className="flex items-start justify-between border-b border-[#edf0ed] p-3"><div><span className="text-[8px] tracking-[.7px] text-[#89958f]">{ticket.pending?'OFFLINE · PENDING SYNC':ticketStatus(ticket).toUpperCase()} · {ticket.orderNumber}</span><h3 className="mt-1 text-[14px] font-bold">{ticket.orderType==='dine_in'?ticket.tableLabel:'Takeaway'}</h3><small className="mt-1 block text-[8px] font-semibold text-[#4d755d]">{ticket.kitchenStation??'Unassigned station'}</small></div><span className="rounded-md bg-[#fff5e8] px-2 py-1 text-[8px] font-bold text-[#ab702d]">{Math.max(0,Math.floor((Date.now()-new Date(ticket.createdAt).getTime())/60000))||'Just now'}{typeof Math.floor((Date.now()-new Date(ticket.createdAt).getTime())/60000)==='number'&&Date.now()-new Date(ticket.createdAt).getTime()>=60000?' min':''}</span></header><div className="flex gap-1.5 px-3 py-2 text-[8px] text-[#8a968f]"><span>{ticket.orderType.toUpperCase().replace('_',' ')}</span><span>·</span><span>{ticket.lines.filter(line=>!line.voidedAt).reduce((sum,line)=>sum+line.quantity,0)} active items</span></div><div className="px-3 pb-2">{ticket.lines.map(line=><div key={line.id} className="flex items-start gap-2 border-b border-dashed border-[#edf0ed] py-2 last:border-0"><span className="grid size-5 shrink-0 place-items-center rounded bg-[#f2f5f2] text-[9px] font-bold text-[#466151]">{line.quantity}</span><span className="min-w-0 flex-1"><strong className={`block text-[9px] font-semibold ${line.voidedAt?'text-[#9aa49e] line-through':''}`}>{line.name}</strong><small className="text-[8px] text-[#9aa49e]">{line.voidedAt?`Voided · ${line.voidReason??'reason unavailable'}`:`${line.kitchenStation}${line.note?` · ${line.note}`:''}`}</small>{!line.voidedAt&&line.modifiers.map(modifier=><small key={modifier.id} className="block text-[8px] text-[#62746a]">↳ {modifier.name}</small>)}</span>{canManage&&!ticket.pending&&!line.voidedAt&&<button onClick={()=>void voidOrderLine(ticket.id,line)} title="Void item with reason" className="rounded border border-[#f0dfdc] px-2 py-1 text-[8px] text-[#a65d4e]">Void</button>}</div>)}</div>{ticket.note&&<p className="mx-3 mb-2 rounded bg-[#fff8ed] p-2 text-[8px] text-[#a17a48]">Note: {ticket.note}</p>}<div className="flex gap-1.5 border-t border-[#edf0ed] bg-[#fbfcfb] p-2.5"><button disabled={ticket.pending} onClick={()=>void updateTicket(ticket,ticketStatus(ticket)==='new'?'preparing':'ready')} className="rounded-md border border-[#e5ebe6] bg-white px-2.5 py-2 text-[8px] font-semibold text-[#607168] disabled:opacity-50">{ticketStatus(ticket)==='new'?'Start preparing':'Mark ready'}</button>{canManage&&!ticket.pending&&<button onClick={()=>void voidWholeOrder(ticket)} className="rounded-md border border-[#f0dfdc] px-2.5 py-2 text-[8px] font-semibold text-[#a65d4e]">Void order</button>}<button disabled={ticket.pending||ticketStatus(ticket)==='ready'} onClick={()=>void updateTicket(ticket,'ready')} className="ml-auto flex items-center gap-1.5 rounded-md border border-[#d7e8db] bg-[#eef6f0] px-2.5 py-2 text-[8px] font-semibold text-[#37704c] disabled:opacity-50"><Check size={12}/>Ready</button></div></article>)}{!visibleTickets.length&&<div className="col-span-full flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#dfe8e1] bg-white text-center"><Flame size={25} className="text-[#d7e2d9]"/><strong className="text-[12px] text-[#607168]">{isOutletEdge?'Kitchen is clear':'Outlet edge is not connected'}</strong><span className="text-[9px] text-[#91a096]">{isOutletEdge?'Orders sent from the POS appear here.':'Connect the outlet edge to display live kitchen tickets.'}</span></div>}</div>
      </section>:<ReportsView timeZone={outletContext?.timeZone} currency={outletContext?.currency??'INR'} canManage={canManage}/>}
      <footer className="mx-3 flex h-8 items-center justify-between border-t border-[#e9eeea] text-[7px] tracking-[.65px] text-[#a4ada7] sm:mx-8"><span>COMMON TABLE · POS PROTOTYPE</span><span>{online?<Wifi size={11} className="inline text-[#6f9b79]"/>:<WifiOff size={11} className="inline text-[#d79543]"/>} <span className="ml-1">{isOutletEdge?`${menuSource} menu · ${menu.length} items · Local-first · ${queue.length} pending`:`${menuSource} menu · ${menu.length} items · Outlet edge required for live orders`}</span></span></footer>
    </main>

    {connectionHelpOpen&&<div className="fixed inset-0 z-30 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-labelledby="edge-help-title" className="w-full max-w-[460px] rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">OUTLET CONNECTION</span><button onClick={()=>setConnectionHelpOpen(false)} aria-label="Close" className="grid size-8 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div><h2 id="edge-help-title" className="mt-2 text-lg font-bold">Use the POS on your outlet network</h2><p className="mt-2 text-sm leading-6 text-[#718077]">{connected?`This browser is connected to ${outletContext?.outletName??'the local edge'}. Orders and kitchen updates are handled by that outlet server.`:'This page is hosted on Vercel. It cannot reach the restaurant SQLite database or printer by itself.'}</p><div className="mt-4 rounded-xl bg-[#f2f7f3] p-3 text-xs leading-5 text-[#52675a]"><p>For cashier and kitchen tablets, open the local edge address on the same outlet Wi-Fi, for example:</p><code className="mt-2 block break-all rounded-lg bg-white px-3 py-2 text-[#28694f]">http://&lt;edge-device&gt;:3001</code><p className="mt-2">The edge server must be running. Its readiness check is available at <code>/api/ready</code>. The Vercel site is for the cloud manager and setup portal.</p></div><button onClick={()=>setConnectionHelpOpen(false)} className="mt-4 flex h-10 w-full items-center justify-center rounded-lg bg-[#27694f] text-sm font-semibold text-white">Got it</button></section></div>}
    {floorOpen&&<div className="fixed inset-0 z-20 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><div className="w-full max-w-[510px] rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><div><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">DINING ROOM</span><h2 className="mt-1 text-lg font-bold">Choose a table</h2></div><button onClick={()=>setFloorOpen(false)} className="grid size-7 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div><div className="mb-3 mt-2 flex gap-3 text-[8px] text-[#84918a]"><span><i className="mr-1 inline-block size-2 rounded-full bg-[#74a984]"/>Available</span><span><i className="mr-1 inline-block size-2 rounded-full bg-[#e6b66f]"/>In service</span></div><div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{['Table 01','Table 02','Table 03','Table 04','Table 05','Patio 01','Bar 01','Bar 02'].map((name,index)=>{const occupied=orders.some(order=>order.tableLabel===name&&['sent','preparing','ready'].includes(order.status));return <button key={name} disabled={occupied} onClick={()=>{setTable(name);setFloorOpen(false);}} className={`flex h-[83px] flex-col items-center justify-center rounded-xl border text-center ${name===table?'border-[#4b8a65] bg-[#edf6ef] text-[#28694f]':occupied?'cursor-not-allowed border-[#efe4d4] bg-[#fff9f0] text-[#aa875a]':'border-[#e7ece8] bg-[#fbfcfb] text-[#64736b] hover:border-[#a9c9b1]'}`}><LayoutGrid size={19}/><strong className="mt-2 text-[9px]">{name}</strong><small className="mt-0.5 text-[7px]">{occupied?'In service':`${index<5?2:4} seats`}</small></button>;})}</div><p className="mt-3 text-[8px] text-[#98a29d]">Occupied tables are locked in this prototype; order transfer and merge come later.</p></div></div>}
    {modifierItem&&<div className="fixed inset-0 z-20 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><div className="w-full max-w-[430px] rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">CUSTOMIZE ITEM</span><button onClick={()=>setModifierItem(null)} className="grid size-7 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div><h2 className="mt-2 text-lg font-bold">{modifierItem.name}</h2><p className="mt-1 text-[9px] text-[#89958e]">Choose the options for this item.</p><div className="mt-4 space-y-4">{[...new Set(modifierItem.modifiers.map(option=>option.group))].map(group=><fieldset key={group}><legend className="mb-2 text-[9px] font-bold text-[#526259]">{group}<span className="ml-1 font-normal text-[#9da7a1]">{group==='Add-on'?'· optional':'· choose one'}</span></legend><div className="space-y-1">{modifierItem.modifiers.filter(option=>option.group===group).map(option=>{const selected=modifierSelection.includes(option.id);return <button type="button" key={option.id} onClick={()=>toggleModifier(option)} className={`flex w-full items-center rounded-lg border px-3 py-2 text-left text-[9px] ${selected?'border-[#a7c8b0] bg-[#f1f7f2] text-[#35684a]':'border-[#edf0ed] text-[#56665d]'}`}><span className={`mr-2 grid size-3.5 place-items-center rounded-full border ${selected?'border-[#3f865b] bg-[#3f865b] text-white':'border-[#cbd5ce]'}`}>{selected&&<Check size={9}/>}</span>{option.name}<span className="ml-auto">{option.priceDeltaMinor?`+${money(option.priceDeltaMinor)}`:'Included'}</span></button>;})}</div></fieldset>)}</div><div className="mt-4 flex items-center justify-between border-t border-[#edf0ed] pt-3"><span className="text-[9px] text-[#87938c]">Item total</span><strong className="text-[14px]">{money(modifierItem.priceMinor+modifierItem.modifiers.filter(option=>modifierSelection.includes(option.id)).reduce((sum,option)=>sum+option.priceDeltaMinor,0))}</strong></div><button onClick={()=>{addConfiguredItem(modifierItem,modifierSelection);setModifierItem(null);}} className="mt-3 flex h-10 w-full items-center rounded-lg bg-[#27694f] px-3 text-[9px] font-bold text-white">Add to order <span className="ml-auto">→</span></button></div></div>}
    {shiftOpen&&<div className="fixed inset-0 z-30 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-labelledby="shift-title" className="max-h-[90vh] w-full max-w-[500px] overflow-y-auto rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">CASH CONTROL</span><button onClick={()=>setShiftOpen(false)} aria-label="Close" className="grid size-8 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div><h2 id="shift-title" className="mt-2 text-lg font-bold">{shiftSummary?.shift.status==='open'?`Shift ${shiftSummary.shift.shiftNumber}`:'Open a shift'}</h2>{!connected&&<p className="mt-2 rounded-lg bg-[#fcf6eb] p-2 text-xs text-[#936e3e]">Shift controls need an active connection to the outlet edge server. Open this POS on the outlet Wi-Fi.</p>}{shiftSummary?.shift.status!=='open'?<><p className="mt-1 text-xs text-[#718077]">Count the starting cash float before taking demo tenders.</p><label className="mt-4 block text-xs font-medium text-[#526259]">Opening float ({outletContext?.currency??'INR'})<input aria-label="Opening float" type="number" min="0" step="0.01" value={openingFloat} onChange={event=>setOpeningFloat(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-[#e5ebe6] px-3 text-sm"/></label><button onClick={()=>void openShift()} disabled={shiftBusy||!connected} className="mt-4 h-10 w-full rounded-lg bg-[#27694f] text-sm font-semibold text-white disabled:opacity-60">{shiftBusy?'Opening…':'Open shift'}</button></>:<><div className="mt-3 grid grid-cols-2 gap-2 text-xs">{[['Opening float',shiftSummary.shift.openingFloatMinor],['Cash sales',shiftSummary.salesByMethod.cash],['UPI sales',shiftSummary.salesByMethod.upi],['Card sales',shiftSummary.salesByMethod.card],['Cash in',shiftSummary.cashInMinor],['Cash out',shiftSummary.cashOutMinor],['Expected drawer',shiftSummary.expectedCashMinor]].map(([label,amount])=><div key={label} className="rounded-lg bg-[#f4f7f4] p-2.5 text-[#758179]"><span>{label}</span><strong className="mt-1 block text-sm text-[#294437]">{money(Number(amount))}</strong></div>)}</div><div className="mt-4 rounded-xl border border-[#e8ede9] p-3"><h3 className="text-xs font-bold text-[#405149]">Cash movement</h3><div className="mt-2 grid grid-cols-2 gap-2"><select aria-label="Movement type" value={movementType} onChange={event=>setMovementType(event.target.value as 'cash_in'|'cash_out')} className="h-9 rounded-lg border border-[#e5ebe6] px-2 text-xs"><option value="cash_in">Cash in</option><option value="cash_out">Cash out</option></select><input aria-label="Movement amount" type="number" min="0.01" step="0.01" placeholder={`Amount ${outletContext?.currency??'INR'}`} value={movementAmount} onChange={event=>setMovementAmount(event.target.value)} className="h-9 rounded-lg border border-[#e5ebe6] px-2 text-xs"/></div><input aria-label="Movement reason" value={movementReason} onChange={event=>setMovementReason(event.target.value)} placeholder="Reason (e.g. petty cash)" className="mt-2 h-9 w-full rounded-lg border border-[#e5ebe6] px-2 text-xs"/><button onClick={()=>void recordCashMovement()} disabled={shiftBusy||!connected} className="mt-2 h-9 w-full rounded-lg border border-[#dfe8e1] text-xs font-semibold text-[#43624f] disabled:opacity-60">Record movement</button></div>{shiftSummary.shift.status==='open'&&<div className="mt-4 border-t border-[#edf0ed] pt-3"><label className="block text-xs font-medium text-[#526259]">Counted drawer cash ({outletContext?.currency??'INR'})<input aria-label="Counted drawer cash" type="number" min="0" step="0.01" value={countedCash} onChange={event=>setCountedCash(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-[#e5ebe6] px-3 text-sm"/></label><p className="mt-2 text-xs text-[#718077]">Expected {money(shiftSummary.expectedCashMinor)} · Variance {money(Math.round(Number(countedCash||0)*100)-shiftSummary.expectedCashMinor)}</p><button onClick={()=>void closeShift()} disabled={shiftBusy||!connected} className="mt-3 h-10 w-full rounded-lg bg-[#27694f] text-sm font-semibold text-white disabled:opacity-60">{shiftBusy?'Closing…':'Close shift'}</button></div>}</>}</section></div>}
    {checkoutOpen&&<div className="fixed inset-0 z-20 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><div className="w-full max-w-[400px] rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">COMPLETE ORDER</span><button onClick={()=>setCheckoutOpen(false)} className="grid size-7 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div><h2 className="mt-3 text-xl font-bold tracking-[-.5px]">Take payment</h2><p className="mt-1 text-[10px] text-[#8b9790]">{editingOrder?(editingOrder.orderType==='dine_in'?editingOrder.tableLabel:'Takeaway'):(orderType==='dine_in'?table:'Takeaway')} · {displayItemCount} items</p><div className="mt-4 flex items-center justify-between rounded-xl bg-[#f4f7f4] p-3 text-[10px] text-[#748078]"><span>Amount due</span><strong className="text-xl text-[#294437]">{money(total)}</strong></div><p className="mb-2 mt-4 text-[9px] text-[#748078]">Choose a payment method</p><div className="grid grid-cols-3 gap-2">{([{id:'cash',name:'Cash',Icon:Banknote},{id:'upi',name:'UPI',Icon:QrCode},{id:'card',name:'Card',Icon:CreditCard}] as const).map(method=><button key={method.id} onClick={()=>setPaymentMethod(method.id)} className={`flex h-14 flex-col items-center justify-center gap-1 rounded-lg border text-[9px] ${paymentMethod===method.id?'border-[#93bba0] bg-[#edf6ef] text-[#34704c]':'border-[#e5ebe6] text-[#78857e]'}`}><method.Icon size={15}/><strong>{method.name}</strong></button>)}</div><button type="button" onClick={()=>{const next=!splitPayment;setSplitPayment(next);setSplitAmount(next?(total/200).toFixed(2):'');}} className="mt-3 w-full rounded-lg border border-[#dfe8e1] py-2 text-[9px] font-semibold text-[#43624f]">{splitPayment?'Remove split tender':'Split between two methods'}</button>{splitPayment&&<div className="mt-3 rounded-xl border border-[#e5ebe6] bg-[#fafcf9] p-3"><label className="block text-[9px] font-semibold text-[#65736b]">Second tender<select aria-label="Second tender method" value={splitMethod} onChange={event=>setSplitMethod(event.target.value as PaymentMethod)} className="mt-1 h-9 w-full rounded-lg border border-[#e5ebe6] bg-white px-2 text-xs">{(['cash','upi','card'] as PaymentMethod[]).filter(method=>method!==paymentMethod).map(method=><option key={method} value={method}>{method.toUpperCase()}</option>)}</select></label><label className="mt-2 block text-[9px] font-semibold text-[#65736b]">Second tender amount ({outletContext?.currency??'INR'})<input aria-label="Second tender amount" type="number" min="0.01" step="0.01" max={(total-1)/100} value={splitAmount} onChange={event=>setSplitAmount(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[#e5ebe6] bg-white px-2 text-xs"/></label><p className="mt-2 text-[9px] text-[#7f8a83]">{paymentMethod.toUpperCase()} remainder: {money(Math.max(0,total-Math.round(Number(splitAmount||0)*100)))}</p></div>}<div className="my-3 rounded-md bg-[#fcf6eb] p-2 text-[8px] leading-relaxed text-[#9b805d]">Prototype only. Records a demo tender on the edge server; no real payment is processed.</div><button onClick={()=>void recordPayment()} disabled={busy} className="flex h-10 w-full items-center gap-2 rounded-lg bg-[#27694f] px-3 text-[9px] font-bold text-white hover:bg-[#1d503c] disabled:opacity-60">{busy?<LoaderCircle size={14} className="animate-spin"/>:'Record demo payment'}<span className="ml-auto">→</span></button></div></div>}
    {toast&&<div role="status" className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-lg bg-[#253b30] px-4 py-2.5 text-[10px] text-white shadow-xl">{toast}</div>}
  </div>;
}

export default App;
