// MY CHAUFFEUR ZIM — V2 REFINED
process.on('uncaughtException', e => console.log('⚠️ Kept alive:', e.message));
process.on('unhandledRejection', e => console.log('⚠️ Kept alive:', e?.message || e));
global.WebSocket = require('ws');

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const fs = require('fs');
const http = require('http');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '').replace(/\D/g, '');
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const BID_WINDOW_SECONDS = Number(process.env.BID_WINDOW_SECONDS || 90);
const AUTH_DIR = 'auth_baileys';

const users = new Map();
const offeredBookings = new Set();
let sock = null, isStarting = false, pairingRequested = false, lastPairingAt = 0, bidInterval = null;

console.log('PHONE_NUMBER:', PHONE_NUMBER || '❌ MISSING - set in Railway');

const WELCOME = `👋 Welcome to My Chauffeur Zim!

1️⃣ Book a Ride 🚕
2️⃣ View Prices 💰
3️⃣ Support 📞
4️⃣ My Booking Status 📦

Type MENU to return here.`;
const money = a => '$' + Number(a).toFixed(2);

function getRates() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Harare', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hour >= 20 || hour < 5) return { night: true, fare: 1.50, driverFee: 1.00 };
  return { night: false, fare: 1.00, driverFee: 0.50 };
}
function calculatePrice(km) {
  const r = getRates();
  return { night: r.night, minimum: Number((km * r.fare).toFixed(2)), maximum: Number((km * (r.fare + r.driverFee)).toFixed(2)) };
}
async function geocode(place, city) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', `${place}, ${city}, Zimbabwe`);
  url.searchParams.set('format', 'json'); url.searchParams.set('limit', '1');
  const res = await fetch(url, { headers: { 'User-Agent': 'MyChauffeurZim/2.0' } });
  if (!res.ok) throw new Error('Geocoding failed');
  const d = await res.json();
  return d.length ? { lat: d[0].lat, lon: d[0].lon } : null;
}
async function getDistanceKm(pickup, destination, city) {
  try {
    const from = await geocode(pickup, city); if (!from) return null;
    await new Promise(r => setTimeout(r, 1100));
    const to = await geocode(destination, city); if (!to) return null;
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`);
    if (!res.ok) return null;
    const d = await res.json();
    return d.routes?.[0] ? Number((d.routes[0].distance / 1000).toFixed(1)) : null;
  } catch (e) { console.log('Distance error:', e.message); return null; }
}
const phoneFromJid = jid => String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
async function reply(jid, text) { try { await sock.sendMessage(jid, { text }); } catch (e) { console.log('Reply error:', e.message); } }
async function notifyOwner(text) {
  if (!OWNER_NUMBER || !sock) return;
  try { await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text }); } catch (e) { console.log('Owner notify:', e.message); }
}
function getText(m) {
  const x = m.message || {};
  return (x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || '').trim();
}

// --- RESTORE ACTIVE BOOKINGS AFTER RESTART ---
async function restoreSessions() {
  try {
    const { data } = await supabase.from('bookings').select('*').in('status', ['open', 'bidding', 'driver_selected']).order('created_at', { ascending: false }).limit(50);
    for (const b of (data || [])) {
      const jid = b.phone + '@s.whatsapp.net';
      if (users.has(jid)) continue;
      users.set(jid, { step: b.status === 'driver_selected' ? 'awaiting_driver' : b.status === 'bidding' ? 'choose_driver' : 'waiting_bids', bookingId: b.id, name: b.customer_name, pickup: b.pickup, destination: b.destination, city: b.city, km: b.distance_km, prices: { minimum: b.min_price, maximum: b.max_price }, bidStartedAt: Date.now() - 10000, offers: [] });
    }
    console.log(`Restored ${users.size} active bookings`);
  } catch (e) { console.log('Restore error:', e.message); }
}

async function handleMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;
  const body = getText(msg); if (!body) return;
  const text = body.toLowerCase().trim();
  const phone = phoneFromJid(jid);

  // --- DRIVER REPLIES: ACCEPT / DECLINE ---
  if (text === 'accept' || text === 'decline') {
    const { data: booking } = await supabase.from('bookings').select('*').eq('selected_driver_id', phone).eq('status', 'driver_selected').order('created_at', { ascending: false }).limit(1).single();
    // Fallback: match by driver_phone in driver_bids
    let b = booking;
    if (!b) {
      const { data: bid } = await supabase.from('driver_bids').select('booking_id').eq('driver_phone', phone).order('created_at', { ascending: false }).limit(1).single();
      if (bid) { const { data: bk } = await supabase.from('bookings').select('*').eq('id', bid.booking_id).eq('status', 'driver_selected').single(); b = bk; }
    }
    if (!b) return reply(jid, 'No pending ride found for you. Please wait for a new assignment.');
    if (text === 'accept') {
      await supabase.from('bookings').update({ status: 'confirmed' }).eq('id', b.id);
      await reply(jid, `✅ You accepted Booking #${b.id}\n\nCustomer: ${b.customer_name} - ${b.phone}\nPickup: ${b.pickup}\nDestination: ${b.destination}\nPlease contact customer now.`);
      await reply(b.phone + '@s.whatsapp.net', `✅ Driver confirmed!\n\nYour driver is on the way for Booking #${b.id}.\nDriver will contact you shortly.`);
      await notifyOwner(`✅ DRIVER ACCEPTED\nBooking: ${b.id}\nDriver: ${phone}`);
    } else {
      await supabase.from('bookings').update({ status: 'driver_declined', selected_bid_id: null, selected_driver_id: null }).eq('id', b.id);
      await reply(jid, 'Declined. Thank you, we will offer it to another driver.');
      await reply(b.phone + '@s.whatsapp.net', `⚠️ Your selected driver declined Booking #${b.id}. We are finding you another driver. Type MENU to re-book or wait for support.`);
      await notifyOwner(`⚠️ DRIVER DECLINED\nBooking: ${b.id}\nDriver: ${phone}`);
    }
    return;
  }

  let u = users.get(jid) || { step: 'menu' };
  const save = () => users.set(jid, u);

  if (['hi', 'hello', 'start', 'menu'].includes(text)) { u = { step: 'menu' }; save(); return reply(jid, WELCOME); }
  if (text === 'cancel') {
    if (u.bookingId) await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', u.bookingId).in('status', ['open', 'bidding']);
    u = { step: 'menu' }; save(); return reply(jid, 'Booking cancelled. Type 1 to book again.');
  }
  if (text === '4' && u.step === 'menu') {
    const { data } = await supabase.from('bookings').select('id,status,pickup,destination').eq('phone', phone).order('created_at', { ascending: false }).limit(1).single();
    if (!data) return reply(jid, 'No bookings found. Type 1 to book.');
    return reply(jid, `📦 Latest Booking #${data.id}\n${data.pickup} → ${data.destination}\nStatus: ${data.status.toUpperCase()}`);
  }

  if (u.step === 'menu') {
    if (text === '1') { u = { step: 'pickup' }; save(); return reply(jid, '🚕 Let us book your ride!\n\nWhere should we pick you up?'); }
    if (text === '2') return reply(jid, `💰 MY CHAUFFEUR ZIM PRICES\n\nDAY: 5AM–8PM\nMin: $1.00/km | Max: $1.50/km\n\nNIGHT: 8PM–5AM\nMin: $1.50/km | Max: $2.50/km\n\nType 1 to book.`);
    if (text === '3') return reply(jid, '📞 Support\nCall / WhatsApp: 0783 264 675');
    return reply(jid, WELCOME);
  }
  if (u.step === 'pickup') { u.pickup = body; u.step = 'destination'; save(); return reply(jid, `Pickup: ${u.pickup}\n\nWhere are you going?`); }
  if (u.step === 'destination') { u.destination = body; u.step = 'city'; save(); return reply(jid, `Destination: ${u.destination}\n\nWhich city is this trip in?`); }
  if (u.step === 'city') {
    u.city = body; u.step = 'calculating'; save();
    await reply(jid, '📍 Calculating driving distance...');
    const km = await getDistanceKm(u.pickup, u.destination, u.city);
    if (!km || km <= 0) { u.step = 'manual_distance'; save(); return reply(jid, 'Could not find the route automatically.\n\nPlease enter distance in km, e.g. 10.'); }
    u.km = km; u.prices = calculatePrice(km); u.step = 'name'; save();
    return reply(jid, `📍 ROUTE FOUND!\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ${km} km\n\nMinimum: ${money(u.prices.minimum)}\nMaximum: ${money(u.prices.maximum)}\n\nWhat is your full name?`);
  }
  if (u.step === 'manual_distance') {
    const km = Number(body);
    if (!Number.isFinite(km) || km <= 0 || km > 1000) return reply(jid, 'Please enter a valid distance, e.g. 10.');
    u.km = Number(km.toFixed(1)); u.prices = calculatePrice(u.km); u.step = 'name'; save();
    return reply(jid, 'What is your full name?');
  }
  if (u.step === 'name') {
    if (body.length < 2) return reply(jid, 'Please enter your full name.');
    u.name = body; u.step = 'review'; save();
    return reply(jid, `🧾 RIDE SUMMARY\n\nName: ${u.name}\nPickup: ${u.pickup}\nDestination: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km} km\n\nMinimum: ${money(u.prices.minimum)}\nMaximum: ${money(u.prices.maximum)}\n\nReply YES to send to drivers.`);
  }
  if (u.step === 'review') {
    if (text !== 'yes') return reply(jid, 'Reply YES to submit or CANCEL.');
    const { data, error } = await supabase.from('bookings').insert({ phone, customer_name: u.name, pickup: u.pickup, destination: u.destination, city: u.city, distance_km: u.km, min_price: u.prices.minimum, max_price: u.prices.maximum, status: 'open' }).select('id').single();
    if (error || !data) { console.log('Booking error:', error?.message); return reply(jid, 'Sorry, could not submit. Please try again.'); }
    u.bookingId = data.id; u.step = 'waiting_bids'; u.bidStartedAt = Date.now(); u.offers = []; save();
    await reply(jid, `✅ REQUEST SUBMITTED!\n\nRef: ${data.id}\n\nWe will send up to 7 driver offers here. Please wait up to ${BID_WINDOW_SECONDS} seconds.`);
    await notifyOwner(`🚕 NEW BOOKING\nRef: ${data.id}\nName: ${u.name}\nPhone: ${phone}\n${u.pickup} → ${u.destination}\n${u.km}km | Min ${money(u.prices.minimum)} | Max ${money(u.prices.maximum)}`);
    return;
  }
  if (u.step === 'waiting_bids') return reply(jid, 'We are collecting driver offers. Please wait.');
  if (u.step === 'choose_driver') {
    const choice = Number(text);
    if (!Number.isInteger(choice) || choice < 1 || choice > (u.offers?.length || 0)) return reply(jid, `Please select 1 to ${u.offers.length}.`);
    const selected = u.offers[choice - 1];
    const { data: booking } = await supabase.from('bookings').select('id,status').eq('id', u.bookingId).single();
    if (!booking || booking.status !== 'bidding') return reply(jid, 'This booking is no longer available. Contact support.');
    const { data: updated, error } = await supabase.from('bookings').update({ status: 'driver_selected', selected_bid_id: selected.id, selected_driver_id: selected.driver_id }).eq('id', u.bookingId).eq('status', 'bidding').select('id');
    if (error || !updated?.length) return reply(jid, 'Could not select. Please contact support.');
    try {
      await sock.sendMessage(String(selected.driver_phone).replace(/\D/g, '') + '@s.whatsapp.net', { text: `🚕 RIDE OFFER SELECTED\n\nBooking: ${u.bookingId}\nCustomer: ${u.name}\nPhone: ${phone}\nPickup: ${u.pickup}\nDestination: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km} km\nYour bid: ${money(selected.price)}\n\nReply ACCEPT to accept or DECLINE to reject.` });
    } catch (e) { console.log('Driver notify:', e.message); return reply(jid, 'Driver notification failed. Support alerted.'); }
    u.step = 'awaiting_driver'; save();
    await reply(jid, `✅ You selected ${selected.driver_name} for ${money(selected.price)}.\n\nWaiting for driver confirmation.`);
    await notifyOwner(`DRIVER SELECTED\nBooking: ${u.bookingId}\nDriver: ${selected.driver_name} - ${money(selected.price)}\nCustomer: ${phone}`);
    return;
  }
  if (u.step === 'awaiting_driver') return reply(jid, 'Your driver has been notified. Waiting for confirmation.');
}

async function checkDriverBids() {
  if (!sock) return;
  for (const [jid, u] of users.entries()) {
    if (u.step !== 'waiting_bids') continue;
    const { data: bids, error } = await supabase.from('driver_bids').select('id,booking_id,driver_id,driver_name,driver_phone,price,created_at').eq('booking_id', u.bookingId).eq('status', 'submitted').order('created_at', { ascending: true }).limit(7);
    if (error) { console.log('Bid lookup:', error.message); continue; }
    const valid = (bids || []).filter(b => b.driver_name && b.driver_phone && Number.isFinite(Number(b.price)) && Number(b.price) > 0);
    const elapsed = Date.now() - u.bidStartedAt;
    if (valid.length >= 7 || (elapsed >= BID_WINDOW_SECONDS * 1000 && valid.length > 0)) {
      if (offeredBookings.has(u.bookingId)) continue;
      offeredBookings.add(u.bookingId);
      u.offers = valid.slice(0, 7); u.step = 'choose_driver'; users.set(jid, u);
      await supabase.from('bookings').update({ status: 'bidding' }).eq('id', u.bookingId).eq('status', 'open');
      const list = u.offers.map((b, i) => `${i + 1}. ${b.driver_name} — ${money(b.price)}`).join('\n');
      await reply(jid, `🚘 DRIVER OFFERS\n\n${list}\n\nReply with the number of your preferred driver.\n\nYour details only go to the driver you select.`);
    }
    if (elapsed >= BID_WINDOW_SECONDS * 1000 && valid.length === 0) {
      await supabase.from('bookings').update({ status: 'no_bids' }).eq('id', u.bookingId).eq('status', 'open');
      users.set(jid, { step: 'menu' });
      await reply(jid, 'Sorry, no drivers submitted an offer. Please try again later.');
    }
  }
}

async function startBot() {
  if (isStarting) return; isStarting = true;
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: ['My Chauffeur Zim', 'Chrome', '2.0.0'], connectTimeoutMs: 60000, keepAliveIntervalMs: 25000, syncFullHistory: false, markOnlineOnConnect: true });
    sock.ev.on('creds.update', saveCreds);
    isStarting = false;

    if (!state.creds.registered && !pairingRequested) {
      if (Date.now() - lastPairingAt < 5 * 60 * 1000) console.log('Pairing cooldown');
      else {
        pairingRequested = true; lastPairingAt = Date.now();
        setTimeout(async () => {
          try {
            if (!PHONE_NUMBER) { console.log('❌ PHONE_NUMBER missing'); pairingRequested = false; return; }
            const code = await sock.requestPairingCode(PHONE_NUMBER);
            console.log('====================================');
            console.log('PAIRING CODE:', code);
            console.log('Type', PHONE_NUMBER, 'in WhatsApp - 20 SECONDS');
            console.log('====================================');
          } catch (e) { console.log('Pairing error:', e.message); }
          setTimeout(() => pairingRequested = false, 60000);
        }, 5000);
      }
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        console.log('✅ ONLINE');
        pairingRequested = false;
        restoreSessions();
        if (!bidInterval) bidInterval = setInterval(() => checkDriverBids().catch(e => console.log('Bid poll:', e.message)), 5000);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log('Disconnected, code:', code);
        if (code === 405) { console.log('⏸️ 405 - sleeping 10 mins'); setTimeout(() => { isStarting = false; startBot(); }, 10 * 60 * 1000); return; }
        if (code === DisconnectReason.loggedOut) { console.log('Logged out - delete auth volume to re-pair'); return; }
        setTimeout(() => { isStarting = false; startBot(); }, 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) { try { await handleMessage(m); } catch (e) { console.log('Msg error:', e.message); } }
    });
  } catch (e) { console.log('Start error, retry 10s:', e.message); isStarting = false; setTimeout(startBot, 10000); }
}

http.createServer((req, res) => { res.writeHead(200); res.end('Bot alive'); }).listen(process.env.PORT || 3000, () => console.log('Health on', process.env.PORT || 3000));
setInterval(() => console.log('💓 Alive', new Date().toISOString()), 30000);
setInterval(() => { if (!sock && !isStarting) { console.log('Watchdog restart'); startBot(); } }, 60000);
console.log('Starting My Chauffeur Zim...');
startBot();
