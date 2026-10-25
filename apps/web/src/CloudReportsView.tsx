import { useEffect, useState } from 'react';
import { BarChart3, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DailySalesReport } from '@common-table/contracts';
import { supabase } from './supabase';

function businessDate(timeZone?:string):string {
  try {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timeZone||undefined,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const values=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch { return new Date().toISOString().slice(0,10); }
}

function csvCell(value:string|number):string {
  let text=String(value);
  if(/^[=+\-@\t\r]/.test(text))text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}

function downloadReport(report:DailySalesReport) {
  const rows:Array<Array<string|number>>=[
    ['section','metric','quantity','amount_minor','currency','details'],
    ['report','date','','',report.currency,report.date],
    ['sales','paid_orders',report.totals.paidOrderCount,'',report.currency,report.timeZone],
    ['sales','subtotal','',report.totals.subtotalMinor,report.currency,''],
    ['sales','tax','',report.totals.taxTotalMinor,report.currency,''],
    ['sales','net_sales','',report.totals.salesMinor,report.currency,'after refunds'],
    ['refunds','refunds',report.refunds.count,report.refunds.amountMinor,report.currency,''],
    ...report.tenders.map(row=>['tender',row.method,row.paymentCount,row.amountMinor,report.currency,'']),
    ...report.items.map(row=>['item',row.name,row.quantity,row.salesMinor,report.currency,row.menuItemId]),
    ['voids','voided_lines',report.voids.lineCount,report.voids.amountMinor,report.currency,`${report.voids.quantity} units`],
    ['shifts','closed_shifts',report.shifts.closedCount,report.shifts.varianceMinor,report.currency,`expected ${report.shifts.expectedCashMinor}; counted ${report.shifts.countedCashMinor}`],
  ];
  const blob=new Blob([`${rows.map(row=>row.map(csvCell).join(',')).join('\r\n')}\r\n`],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`${report.outletName.replace(/[^a-z0-9-]+/gi,'-').toLowerCase()}-${report.date}-cloud-report.csv`;
  document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
}

export default function CloudReportsView({tenantId,outletId,outletName,timeZone}:{tenantId:string;outletId:string;outletName:string;timeZone?:string|undefined}) {
  const [date,setDate]=useState(()=>businessDate(timeZone));
  const [report,setReport]=useState<DailySalesReport|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>setDate(businessDate(timeZone)),[timeZone,outletId]);

  useEffect(()=>{
    if(!supabase||!tenantId||!outletId||!date)return;
    let active=true;
    void(async()=>{
      setLoading(true);setError('');
      const {data,error:invokeError}=await supabase.functions.invoke('pos-reports',{body:{tenantId,outletId,date}});
      if(!active)return;
      if(invokeError){setError(invokeError.message||'Cloud report could not be loaded.');setLoading(false);return;}
      if(!data||typeof data!=='object'||!('totals'in data)){setError('Cloud report returned an invalid response.');setLoading(false);return;}
      setReport(data as DailySalesReport);setLoading(false);
    })().catch(cause=>{if(active){setError(cause instanceof Error?cause.message:'Cloud report could not be loaded.');setLoading(false);}});
    return()=>{active=false;};
  },[tenantId,outletId,date,refresh]);

  const money=(minor:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:report?.currency??'INR'}).format(minor/100);
  const card='rounded-2xl border border-[#e1e8e1] bg-white p-5 shadow-[0_8px_20px_rgba(25,37,34,.035)]';
  return <section className="mt-7 rounded-3xl border border-[#dce7dc] bg-[#edf4ee] p-5 sm:p-7">
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="mb-1.5 text-xs font-bold uppercase tracking-[.14em] text-[#75887a]">Cloud control plane</p><h2 className="text-2xl font-bold tracking-tight text-[#263c30]">Daily sales report</h2><p className="mt-1 text-xs text-[#75847a]">Synced outlet events · {outletName}</p></div><div className="flex items-center gap-2"><label className="text-xs font-semibold text-[#718078]">Business date<input aria-label="Cloud report date" type="date" value={date} onChange={event=>setDate(event.target.value)} className="ml-2 h-10 rounded-lg border border-[#dfe6e1] bg-white px-2 text-xs"/></label><button type="button" aria-label="Refresh cloud report" onClick={()=>setRefresh(value=>value+1)} disabled={loading} className="grid size-10 place-items-center rounded-lg border border-[#dfe6e1] bg-white text-[#587060] disabled:opacity-50"><RefreshCw size={14}/></button>{report&&<button type="button" onClick={()=>downloadReport(report)} className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#286a4f] px-3 text-xs font-bold text-white"><Download size={14}/>Export CSV</button>}</div></header>
    {error&&<div role="alert" className="mb-4 rounded-xl border border-[#f1c8c0] bg-[#fff4f1] px-4 py-3 text-sm text-[#9a493d]">{error}</div>}
    {loading&&!report?<div className="grid min-h-48 place-items-center rounded-2xl bg-white"><LoaderCircle className="animate-spin text-[#38805a]" size={25}/></div>:report?<>
      <div className="mb-4 flex items-center gap-2 text-[10px] text-[#87948d]"><BarChart3 size={14}/><span>{report.outletName}</span><span>·</span><span>{report.date}</span><span>·</span><span>{report.timeZone}</span><span className="ml-auto">{loading?'Refreshing…':`Updated ${new Date(report.generatedAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}`}</span></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[
        ['Net sales',money(report.totals.salesMinor),`${report.totals.paidOrderCount} paid orders`],
        ['Tax collected',money(report.totals.taxTotalMinor),'After tax refunds'],
        ['Refunds',money(report.refunds.amountMinor),`${report.refunds.count} recorded`],
        ['Cash variance',money(report.shifts.varianceMinor),`${report.shifts.closedCount} shifts closed`],
        ['Voids',money(report.voids.amountMinor),`${report.voids.lineCount} lines · ${report.voids.quantity} units`],
      ].map(([label,value,caption])=><article key={label} className={card}><p className="text-[10px] font-semibold text-[#87948d]">{label}</p><strong className="mt-2 block text-[21px] tracking-[-.5px] text-[#293c31]">{value}</strong><small className="mt-1 block text-[9px] text-[#98a29d]">{caption}</small></article>)}</div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2"><section className={card}><h3 className="mb-3 text-sm font-bold">Tender totals</h3>{report.tenders.length?<ul className="divide-y divide-[#edf0ed]">{report.tenders.map(row=><li key={row.method} className="flex justify-between py-2.5 text-xs"><span className="capitalize text-[#607168]">{row.method} <small className="ml-1 text-[#98a29d]">{row.paymentCount} payments</small></span><strong>{money(row.amountMinor)}</strong></li>)}</ul>:<p className="text-xs text-[#98a29d]">No cloud tender events for this date.</p>}</section>
        <section className={card}><h3 className="mb-1 text-sm font-bold">Item sales</h3><p className="mb-3 text-[10px] text-[#98a29d]">Gross items before order-level refunds.</p>{report.items.length?<div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-[9px] uppercase tracking-wide text-[#98a29d]"><tr><th className="pb-2">Item</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Sales</th></tr></thead><tbody className="divide-y divide-[#edf0ed]">{report.items.map(row=><tr key={`${row.menuItemId}:${row.name}`}><td className="py-2 text-[#526259]">{row.name}</td><td className="py-2 text-right">{row.quantity}</td><td className="py-2 text-right font-semibold">{money(row.salesMinor)}</td></tr>)}</tbody></table></div>:<p className="text-xs text-[#98a29d]">No paid item events for this date.</p>}</section></div>
      <p className="mt-4 rounded-xl border border-[#efe5ce] bg-[#fffaf0] p-3 text-[10px] leading-5 text-[#8a7857]">Cloud totals include only events acknowledged by Supabase. Outlet-local orders remain usable during a network outage and appear here after the edge sync queue is acknowledged.</p>
    </>:<div className="grid min-h-48 place-items-center rounded-2xl bg-white text-xs text-[#98a29d]">{error?'Cloud report unavailable':'Loading cloud report…'}</div>}
  </section>;
}
