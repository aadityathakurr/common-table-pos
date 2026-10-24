export type OrderType = 'dine_in' | 'takeaway';
export type OrderStatus = 'sent' | 'preparing' | 'ready' | 'paid' | 'cancelled';
export type PaymentMethod = 'cash' | 'upi' | 'card';

export interface ModifierOption {
  id: string;
  group: string;
  name: string;
  priceDeltaMinor: number;
}

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  priceMinor: number;
  emoji: string;
  color: string;
  tag?: string;
  vegetarian: boolean;
  available: boolean;
  kitchenStation: string;
  modifiers: ModifierOption[];
}

export interface OrderLineDraft {
  menuItemId: string;
  quantity: number;
  note?: string;
  modifierIds?: string[];
}

export interface CreateOrderCommand {
  commandId: string;
  tenantId: string;
  outletId: string;
  terminalId: string;
  orderType: OrderType;
  tableLabel?: string;
  guestCount?: number;
  note?: string;
  lines: OrderLineDraft[];
}

export interface OrderLine {
  id: string;
  menuItemId: string;
  name: string;
  category: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  note?: string;
  kitchenStation: string;
  modifiers: ModifierOption[];
}

export interface KitchenOrder {
  id: string;
  orderNumber: string;
  orderType: OrderType;
  tableLabel: string | null;
  status: OrderStatus;
  note: string | null;
  createdAt: string;
  lines: OrderLine[];
}

export interface OrderRecord extends KitchenOrder {
  commandId: string;
  tenantId: string;
  outletId: string;
  terminalId: string;
  guestCount: number;
  invoiceNumber?: string;
  taxRateBps: number;
  subtotalMinor: number;
  taxTotalMinor: number;
  totalMinor: number;
  paymentMethod?: PaymentMethod;
}

export interface PaymentCommand {
  commandId: string;
  orderId: string;
  method: PaymentMethod;
  amountMinor: number;
}

export interface ServerMessage {
  type: 'kitchen.snapshot' | 'order.created' | 'order.updated' | 'server.ready';
  payload: KitchenOrder[] | KitchenOrder | { outletId: string };
}

export const DEMO_MENU: MenuItem[] = [
  {id:'flat-white',name:'Flat white',category:'Coffee',priceMinor:18000,emoji:'☕',color:'#efe4d4',tag:'BESTSELLER',vegetarian:true,available:true,kitchenStation:'Coffee',modifiers:[{id:'flat-white-size-regular',group:'Size',name:'Regular',priceDeltaMinor:0},{id:'flat-white-size-large',group:'Size',name:'Large',priceDeltaMinor:5000},{id:'flat-white-milk-dairy',group:'Milk',name:'Dairy',priceDeltaMinor:0},{id:'flat-white-milk-oat',group:'Milk',name:'Oat milk',priceDeltaMinor:2500},{id:'flat-white-milk-almond',group:'Milk',name:'Almond milk',priceDeltaMinor:3500}]},
  {id:'iced-oat-latte',name:'Iced oat latte',category:'Coffee',priceMinor:22000,emoji:'🧋',color:'#e9e1d5',tag:'POPULAR',vegetarian:true,available:true,kitchenStation:'Coffee',modifiers:[{id:'latte-size-regular',group:'Size',name:'Regular',priceDeltaMinor:0},{id:'latte-size-large',group:'Size',name:'Large',priceDeltaMinor:5000},{id:'latte-milk-oat',group:'Milk',name:'Oat milk',priceDeltaMinor:0},{id:'latte-milk-dairy',group:'Milk',name:'Dairy',priceDeltaMinor:0},{id:'latte-milk-almond',group:'Milk',name:'Almond milk',priceDeltaMinor:3500}]},
  {id:'masala-chai',name:'Masala chai',category:'Coffee',priceMinor:11000,emoji:'🍵',color:'#f2e6d3',vegetarian:true,available:true,kitchenStation:'Coffee',modifiers:[{id:'chai-size-regular',group:'Size',name:'Regular',priceDeltaMinor:0},{id:'chai-size-large',group:'Size',name:'Large',priceDeltaMinor:3000},{id:'chai-sugar-normal',group:'Sugar',name:'Regular sugar',priceDeltaMinor:0},{id:'chai-sugar-less',group:'Sugar',name:'Less sugar',priceDeltaMinor:0},{id:'chai-sugar-none',group:'Sugar',name:'No sugar',priceDeltaMinor:0}]},
  {id:'cold-brew',name:'Cold brew',category:'Coffee',priceMinor:19500,emoji:'🥤',color:'#e4e0d8',vegetarian:true,available:true,kitchenStation:'Coffee',modifiers:[{id:'coldbrew-size-regular',group:'Size',name:'Regular',priceDeltaMinor:0},{id:'coldbrew-size-large',group:'Size',name:'Large',priceDeltaMinor:5000}]},
  {id:'avocado-toast',name:'Avocado toast',category:'Brunch',priceMinor:31000,emoji:'🥑',color:'#e5eddc',tag:'POPULAR',vegetarian:true,available:true,kitchenStation:'Hot kitchen',modifiers:[{id:'toast-add-egg',group:'Add-on',name:'Add poached egg',priceDeltaMinor:7000},{id:'toast-add-avocado',group:'Add-on',name:'Extra avocado',priceDeltaMinor:8000}]},
  {id:'mushroom-melt',name:'Mushroom melt',category:'Brunch',priceMinor:28500,emoji:'🥪',color:'#f2e3ce',vegetarian:true,available:true,kitchenStation:'Hot kitchen',modifiers:[{id:'melt-add-cheese',group:'Add-on',name:'Extra cheese',priceDeltaMinor:5000},{id:'melt-add-fries',group:'Add-on',name:'Side of fries',priceDeltaMinor:7000}]},
  {id:'paneer-wrap',name:'Paneer tikka wrap',category:'Brunch',priceMinor:26000,emoji:'🌯',color:'#f4e4d3',tag:'CHEF PICK',vegetarian:true,available:true,kitchenStation:'Hot kitchen',modifiers:[{id:'wrap-spice-mild',group:'Spice',name:'Mild',priceDeltaMinor:0},{id:'wrap-spice-medium',group:'Spice',name:'Medium',priceDeltaMinor:0},{id:'wrap-spice-hot',group:'Spice',name:'Hot',priceDeltaMinor:0}]},
  {id:'eggs-toast',name:'Eggs on toast',category:'Brunch',priceMinor:27500,emoji:'🍳',color:'#efe5ce',vegetarian:false,available:true,kitchenStation:'Hot kitchen',modifiers:[{id:'eggs-style-poached',group:'Egg style',name:'Poached',priceDeltaMinor:0},{id:'eggs-style-scrambled',group:'Egg style',name:'Scrambled',priceDeltaMinor:0},{id:'eggs-style-fried',group:'Egg style',name:'Fried',priceDeltaMinor:0}]},
  {id:'blueberry-pancakes',name:'Blueberry pancakes',category:'Bakery',priceMinor:29000,emoji:'🥞',color:'#f0e2e2',vegetarian:true,available:true,kitchenStation:'Hot kitchen',modifiers:[{id:'pancake-add-cream',group:'Add-on',name:'Whipped cream',priceDeltaMinor:4000}]},
  {id:'butter-croissant',name:'Butter croissant',category:'Bakery',priceMinor:14500,emoji:'🥐',color:'#f1e2cc',tag:'FRESH',vegetarian:true,available:true,kitchenStation:'Bakery',modifiers:[{id:'croissant-warm',group:'Preparation',name:'Warm it up',priceDeltaMinor:0}]},
  {id:'chocolate-brownie',name:'Chocolate brownie',category:'Bakery',priceMinor:16000,emoji:'🍰',color:'#eadfd9',vegetarian:true,available:true,kitchenStation:'Bakery',modifiers:[{id:'brownie-icecream',group:'Add-on',name:'Vanilla ice cream',priceDeltaMinor:6000}]},
  {id:'fruit-bowl',name:'Seasonal fruit bowl',category:'Bakery',priceMinor:21000,emoji:'🍓',color:'#f2e2e0',vegetarian:true,available:true,kitchenStation:'Cold prep',modifiers:[]},
];
