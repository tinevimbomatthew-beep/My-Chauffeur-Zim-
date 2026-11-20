global.WebSocket = require('ws');
process.on('uncaughtException', e => console.log('Kept alive:', e.message));
process.on('unhandledRejection', e => console.log('Kept alive:', e?.message || e));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const http = require('http');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const BID_WINDOW_SECONDS = Number(process.env.BID_WINDOW_SECONDS || 90);

const users = new Map();
const offeredBookings = new Set();
let sock = null, isStarting = false, pairingRequested = false, bidInterval = null;

const money = a => '$' + Number(a).toFixed(2);

const WELCOME = `👋 Welcome to My Chauffeur Zim!

How can we help you today?

Type 1 to Book a Ride 🚕
Type 2 for Prices 💰
Type 3 for Support 📞`;

const PRICES = `💰 My Chauffeur Zim Prices

$1.00 per kilometer plus $0.50 driver fee making it a total of $1.50

That means your total is $1.50 for every kilometer you travel.

Example:
10km trip = $15.00

Drivers on our website will send you their exact offer. You choose the one you like.

Type 1 to Book a Ride`;

async function reply(jid, text) {
  try { await sock.sendMessage(jid, { text }); } catch (e) { console.log('Reply error:', e.message); }
}

async function checkDriverBids() {
  if (!sock) return;
  for (const [jid, u] of users.entries()) {
    if (u.step !== 'waiting_bids') continue;
    const { data: bids, error } = await supabase.from('driver_bids')
      .select('id,booking_id,driver_id,driver_name,driver_phone,price,created_at')
      .eq('booking_id', u.bookingId)
      .eq('status', 'submitted')
      .order('created_at', { ascending: true })
      .limit(7);
    if (error) { console.log('Bid lookup:', error.message); continue; }
    const valid = (bids || []).filter(b => b.driver_name && b.driver_phone && Number.isFinite(Number(b.price)) && Number(b.price) > 0);
    const elapsed = Date.now() - u.bidStartedAt;
    if (valid.length >= 7 || (elapsed >= BID_WINDOW_SECONDS * 1000 && valid.length > 0)) {
      if (offeredBookings.has(u.bookingId)) continue;
      offeredBookings.add(u.bookingId);
      u.offers = valid.slice(0, 7);
      u.step = 'choose_driver';
      users.set(jid, u);
      await supabase.from('bookings').update({ status: 'bidding' }).eq('id', u.bookingId).eq('status', 'open');
      const list = u.offers.map((b, i) => `${i + 1}. ${b.driver_name} — ${money(b.price)}`).join('\n');
      await reply(jid, `🚘 DRIVER OFFERS - From Website\n\n${list}\n\nThese prices were set by drivers on our website.\n\nReply with the number of your preferred driver.`);
    }
    if (elapsed >= BID_WINDOW_SECONDS * 1000 && valid.length === 0) {
      await supabase.from('bookings').update({ status: 'no_bids' }).eq('id', u.bookingId).eq('status', 'open');
      users.set(jid, { step: 'menu' });
      await reply(jid, 'Sorry, no drivers submitted an offer. Please try again later.');
    }
  }
}

async function handleMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;
  const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
  if (!body) return;
  const text = body.toLowerCase();
  const phone = jid.split('@')[0].split(':')[0];

  if (text === 'accept' || text === 'decline') {
    const { data: bid } = await supabase.from('driver_bids').select('booking_id,driver_phone').eq('driver_phone', phone).order('created_at', { ascending: false }).limit(1).single();
    if (!bid) return reply(jid, 'No pending ride found for you.');
    const { data: bk } = await supabase.from('bookings').select('*').eq('id', bid.booking_id).eq('status', 'driver_selected').single();
    if (!bk) return reply(jid, 'No pending ride found for you.');
    if (text === 'accept') {
      await supabase.from('bookings').update({ status: 'confirmed' }).eq('id', bk.id);
      await reply(jid, `✅ You accepted Booking #${bk.id}\n\nCustomer: ${bk.customer_name} - ${bk.phone}\nPickup: ${bk.pickup}\nDestination: ${bk.destination}\nPlease contact customer now.`);
      await reply(bk.phone + '@s.whatsapp.net', `✅ Driver confirmed!\n\nYour driver is on the way for Booking #${bk.id}. Driver will contact you shortly.`);
      if (OWNER_NUMBER) await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `✅ DRIVER ACCEPTED\nBooking: ${bk.id}\nDriver: ${phone}` });
    } else {
      await supabase.from('bookings').update({ status: 'driver_declined', selected_bid_id: null, selected_driver_id: null }).eq('id', bk.id);
      await reply(jid, 'Declined. Thank you.');
      await reply(bk.phone + '@s.whatsapp.net', `⚠️ Your selected driver declined Booking #${bk.id}. We are finding you another driver. Type MENU to re-book.`);
    }
    return;
  }

  if (!users.has(jid)) users.set(jid, { step: 'menu' });
  const u = users.get(jid);
  const save = () => users.set(jid, u);

  if (['hi', 'hello', 'start', 'menu'].includes(text)) { u.step = 'menu'; save(); return reply(jid, WELCOME); }
  if (text === 'cancel') {
    if (u.bookingId) await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', u.bookingId).in('status', ['open', 'bidding']);
    users.set(jid, { step: 'menu' }); return reply(jid, 'Booking cancelled. Type 1 to book again.');
  }

  if (u.step === 'menu') {
    if (text === '1') { u.step = 'pickup'; save(); return reply(jid, 'Great! Let\'s book your ride 🚕\n\nWhere should we pick you up? Send your pickup location.'); }
    if (text === '2') return reply(jid, PRICES);
    if (text === '3') return reply(jid, '📞 Support\n\nCall / WhatsApp us on 0783 264 675\n\nType 1 to Book a Ride');
    return reply(jid, WELCOME);
  }

  if (u.step === 'pickup') { u.pickup = body; u.step = 'destination'; save(); return reply(jid, `Pickup: ${u.pickup}\n\nWhere are you going to? Send your destination.`); }
  if (u.step === 'destination') { u.destination = body; u.step = 'city'; save(); return reply(jid, `From: ${u.pickup}\nTo: ${u.destination}\n\nWhich city is this trip in? e.g. Harare, Bulawayo, Mutare`); }
  if (u.step === 'city') { u.city = body; u.step = 'name'; save(); return reply(jid, `City: ${u.city}\n\nWhat is your name?`); }

  if (u.step === 'name') {
    u.name = body; u.step = 'review'; save();
    return reply(jid, `🧾 RIDE SUMMARY\n\nName: ${u.name}\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\n\nPricing: $1.00/km + $0.50 driver fee = $1.50/km max\nDrivers on our website will send you their exact price.\n\nReply YES to send your request to drivers.`);
  }

  if (u.step === 'review') {
    if (text !== 'yes') return reply(jid, 'Reply YES to submit or CANCEL.');
    const { data, error } = await supabase.from('bookings').insert([{
      phone, customer_name: u.name, pickup: u.pickup, destination: u.destination, city: u.city,
      status: 'open', source: 'whatsapp'
    }]).select('id').single();
    if (error || !data) { console.log('Booking error:', error?.message); return reply(jid, 'Sorry, could not submit. Please try again.'); }
    u.bookingId = data.id; u.step = 'waiting_bids'; u.bidStartedAt = Date.now(); u.offers = []; save();
    await reply(jid, `✅ REQUEST SUBMITTED!\n\nRef: ${data.id}\n\nYour request is now on the driver website. Drivers will set their price.\n\nWe will send you up to 7 driver offers here. Please wait up to ${BID_WINDOW_SECONDS} seconds.`);
    if (OWNER_NUMBER) await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `🚨 NEW BOOKING - My Chauffeur Zim\n\nName: ${u.name}\nPhone: ${phone}\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nRef: ${data.id}\n\nDrivers: set your price on website.` });
    return;
  }

  if (u.step === 'waiting_bids') return reply(jid, 'We are collecting driver offers from the website. Please wait.');

  if (u.step === 'choose_driver') {
    const choice = Number(text);
    if (!Number.isInteger(choice) || choice < 1 || choice > (u.offers?.length || 0)) return reply(jid, `Please select 1 to ${u.offers.length}.`);
    const selected = u.offers[choice - 1];
    const { data: booking } = await supabase.from('bookings').select('id,status').eq('id', u.bookingId).single();
    if (!booking || booking.status !== 'bidding') return reply(jid, 'This booking is no longer available. Contact support.');
    const { data: updated, error } = await supabase.from('bookings').update({ status: 'driver_selected', selected_bid_id: selected.id, selected_driver_id: selected.driver_id }).eq('id', u.bookingId).eq('status', 'bidding').select('id');
    if (error || !updated?.length) return reply(jid, 'Could not select. Please contact support.');
    try {
      await sock.sendMessage(String(selected.driver_phone).replace(/[^0-9]/g, '') + '@s.whatsapp.net', { text: `🚕 RIDE OFFER SELECTED\n\nBooking: ${u.bookingId}\nCustomer: ${u.name}\nPhone: ${phone}\nPickup: ${u.pickup}\nDestination: ${u.destination}\nCity: ${u.city}\nYour bid: ${money(selected.price)}\n\nReply ACCEPT to accept or DECLINE to reject.` });
    } catch (e) { console.log('Driver notify:', e.message); return reply(jid, 'Driver notification failed. Support alerted.'); }
    u.step = 'awaiting_driver'; save();
    await reply(jid, `✅ You selected ${selected.driver_name} for ${money(selected.price)}.\n\nWaiting for driver confirmation.`);
    return;
  }

  if (u.step === 'awaiting_driver') return reply(jid, 'Your driver has been notified. Waiting for confirmation.');
}

async function startBot() {
  if (isStarting) return; isStarting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys_v2');
    sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: ['My Chauffeur Zim', 'Chrome', '1.0.0'], connectTimeoutMs: 60000, keepAliveIntervalMs: 25000, syncFullHistory: false });
    sock.ev.on('creds.update', saveCreds);
    isStarting = false;

    // AUTO-REFRESH PAIRING CODE EVERY 15s
    if (!state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      let attempts = 0;
      const askForCode = async () => {
        if (state.creds.registered) return;
        if (attempts >= 12) { console.log('Stopped auto codes after 3 mins. Restart for more.'); pairingRequested = false; return; }
        attempts++;
        try {
          console.log(`Pairing for number: ${PHONE_NUMBER} - Attempt ${attempts}/12`);
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log('====================================');
          console.log(`YOUR PAIRING CODE IS: ${code} <- USE THIS ONE`);
          console.log('Next fresh code in 15 seconds if you miss this one...');
          console.log('====================================');
        } catch (e) {
          console.log('Pairing error:', e.message);
          if (e.message.includes('405')) { console.log('Rate limited - waiting 5 mins'); setTimeout(() => { pairingRequested = false; }, 5 * 60 * 1000); return; }
        }
        setTimeout(askForCode, 15000);
      };
      setTimeout(askForCode, 5000);
    }

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        console.log('My Chauffeur Zim Bot is ready!');
        pairingRequested = false;
        if (!bidInterval) bidInterval = setInterval(() => checkDriverBids().catch(e => console.log('Bid poll:', e.message)), 5000);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log('Connection closed, code:', code, 'reconnecting');
        if (code === DisconnectReason.loggedOut || code === 401) { console.log('Logged out - change auth folder name to _v3 and redeploy to re-pair'); return; }
        setTimeout(() => { isStarting = false; startBot(); }, 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) { try { await handleMessage(m); } catch (e) { console.log('Message error:', e.message); } }
    });
  } catch (e) { console.log('Start error, retry 10s:', e.message); isStarting = false; setTimeout(startBot, 10000); }
}

http.createServer((req, res) => { res.writeHead(200); res.end('Bot alive'); }).listen(process.env.PORT || 3000, () => console.log('Health on', process.env.PORT || 3000));
setInterval(() => console.log('💓 Alive', new Date().toISOString()), 30000);
console.log('Starting My Chauffeur Zim Bot...');
console.log('Pairing for number:', PHONE_NUMBER);
startBot();
