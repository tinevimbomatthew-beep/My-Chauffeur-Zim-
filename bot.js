global.WebSocket = require('ws');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');

const users = {};

// --- NEW: MIN/MAX RULE - ADDED, OLD CODE KEPT ---
function isNight(){ return new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Harare'})).getHours() >= 20; }
function calcPrice(km, wantMax){
  const night = isNight();
  const MIN = night ? 1.50 : 1.00; // compulsory, cannot go below
  const MAX = night ? 2.00 : 1.50; // cannot go above
  const perKm = wantMax ? MAX : MIN;
  return { night, MIN, MAX, perKm, total: perKm*km, minimum: MIN*km, maximum: MAX*km };
}
function validateBid(km, total){
  const p = calcPrice(km, false);
  if(total < p.minimum - 0.01) return {ok:false, reason:`Below MIN $${p.minimum.toFixed(2)}`};
  if(total > p.maximum + 0.01) return {ok:false, reason:`Above MAX $${p.maximum.toFixed(2)}`};
  return {ok:true};
}
// --- END NEW ---

const WELCOME = `👋 Welcome to My Chauffeur Zim!

How can we help you today?

Type 1 to Book a Ride 🚕
Type 2 for Prices 💰
Type 3 for Support 📞`;

// --- UPDATED PRICES TEXT ONLY - SAME FLOW ---
const PRICES = `💰 My Chauffeur Zim Prices - RULE, Cannot Be Broken

Day: MIN $1.00/km - MAX $1.50/km
Night (from 8pm): MIN $1.50/km - MAX $2.00/km

Driver fee is OPTIONAL. Cheapest driver wins.
Example 10km: Day $10-$15, Night $15-$20

Type 1 to Book a Ride`;

async function getDistanceKm(pickup, destination, city) {
  try {
    async function geocode(place) {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place + ', ' + city + ', Zimbabwe')}&limit=1`;
      const res = await fetch(url, { headers: { 'User-Agent': 'MyChauffeurZim/1.0' } });
      const data = await res.json();
      if (!data[0]) return null;
      return { lat: data[0].lat, lon: data[0].lon };
    }
    const from = await geocode(pickup);
    const to = await geocode(destination);
    if (!from || !to) return null;
    const routeUrl = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
    const routeRes = await fetch(routeUrl);
    const routeData = await routeRes.json();
    if (!routeData.routes || !routeData.routes[0]) return null;
    return (routeData.routes[0].distance / 1000).toFixed(1);
  } catch (e) { console.log('Distance calc error:', e.message); return null; }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['My Chauffeur Zim', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingInterval = null;

  // --- PAIRING CODE - SAME AS YOUR WORKING CODE, EVERY 50 SEC ---
  if (!sock.authState.creds.registered) {
    console.log('Pairing for number:', PHONE_NUMBER);
    const askCode = async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('YOUR PAIRING CODE IS:', code);
        console.log('USE THIS LATEST CODE - OLD CODES ARE DEAD');
      } catch (e) { console.log('Pairing error:', e.message); }
    };
    setTimeout(askCode, 5000);
    pairingInterval = setInterval(askCode, 50000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      if (pairingInterval) clearInterval(pairingInterval);
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      if (pairingInterval) clearInterval(pairingInterval);
      console.log('My Chauffeur Zim Bot is ready!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const from = msg.key.remoteJid;
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const text = body.trim().toLowerCase();
      const reply = async (txt) => { await sock.sendMessage(from, { text: txt }); };
      if (!users[from]) users[from] = { step: 'menu' };
      const u = users[from];
      if (text === 'hi' || text === 'hello' || text === 'start' || text === 'menu') {
        u.step = 'menu';
        return await reply(WELCOME);
      }
      if (u.step === 'menu') {
        if (text === '1') { u.step = 'pickup'; return await reply('Great! Let\'s book your ride 🚕\n\nWhere should we pick you up? Send your pickup location.'); }
        if (text === '2') return await reply(PRICES);
        if (text === '3') return await reply('📞 Support\n\nCall / WhatsApp us on 0783 264 675\n\nType 1 to Book a Ride');
      }
      if (u.step === 'pickup') { u.pickup = body.trim(); u.step = 'destination'; return await reply(`Pickup: ${u.pickup}\n\nWhere are you going to? Send your destination.`); }
      if (u.step === 'destination') { u.destination = body.trim(); u.step = 'city'; return await reply(`From: ${u.pickup}\nTo: ${u.destination}\n\nWhich city is this trip in? e.g. Harare, Bulawayo, Mutare`); }
      if (u.step === 'city') {
        u.city = body.trim();
        await reply('Calculating distance... please wait a moment');
        const autoKm = await getDistanceKm(u.pickup, u.destination, u.city);
        if (autoKm) {
          u.km = parseFloat(autoKm);
          // NEW: Use MIN/MAX - show range, not just $1.50 flat
          const pMin = calcPrice(u.km, false);
          const pMax = calcPrice(u.km, true);
          u.totalMin = pMin.total.toFixed(2); u.totalMax = pMax.total.toFixed(2);
          u.total = pMax.total.toFixed(2); // default MAX, driver can waive fee to MIN
          u.step = 'distance_confirm';
          return await reply(`Distance Found!\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ~${u.km}km\n\nPrice Range (MIN/MAX RULE):\nDay/Night: $${u.totalMin} (MIN, no fee) - $${u.totalMax} (MAX, with fee)\n${pMin.night ? '🌙 Night rate: MIN $1.50/km MAX $2.00/km' : '☀️ Day rate: MIN $1.00/km MAX $1.50/km'}\n\nReply YES to use ${u.km}km, or send a different number.\n\nNo need to open any map - you can book right here on WhatsApp.`);
        } else {
          u.step = 'distance_manual';
          return await reply(`I couldn't auto-calculate it.\n\nHow many kilometers is the trip? Just send the number, e.g. 10\n\nNo need to open any map - just type the number here on WhatsApp.`);
        }
      }
      if (u.step === 'distance_confirm') {
        if (text === 'yes') { u.step = 'name'; return await reply('Perfect! What is your name?'); }
        const km = parseFloat(text);
        if (!isNaN(km)) { u.km = km; const pMin = calcPrice(km,false); const pMax = calcPrice(km,true); u.totalMin=pMin.total.toFixed(2); u.totalMax=pMax.total.toFixed(2); u.total=pMax.total.toFixed(2); u.step = 'name'; return await reply(`Got it, using ${km}km. Price $${u.totalMin} - $${u.totalMax}.\n\nWhat is your name?`); }
        return await reply('Reply YES to use that distance, or send a different number.');
      }
      if (u.step === 'distance_manual') {
        const km = parseFloat(text);
        if (isNaN(km)) return await reply('Please send just the number of kilometers, e.g. 10');
        u.km = km; const pMin = calcPrice(km,false); const pMax = calcPrice(km,true); u.totalMin=pMin.total.toFixed(2); u.totalMax=pMax.total.toFixed(2); u.total=pMax.total.toFixed(2); u.step = 'name';
        return await reply('Got it! What is your name?');
      }
      if (u.step === 'name') {
        u.name = body.trim(); u.step = 'confirm';
        // Keep your original bookings insert, add price range
        await supabase.from('bookings').insert([{ phone: from, customer_name: u.name, pickup: u.pickup, destination: u.destination, city: u.city, distance_km: u.km, price: u.total, status: 'pending' }]);
        return await reply(`✅ Price Estimate\n\nName: ${u.name}\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km}km\n\nPricing RULE:\nMIN: $${u.totalMin} (no driver fee)\nMAX: $${u.totalMax} (with driver fee)\nDrivers will bid between MIN and MAX. Cheapest wins. No driver can go below MIN or above MAX.\n\nReply YES to confirm this booking, or type 1 to start again.`);
      }
      if (u.step === 'confirm' && text === 'yes') {
        u.step = 'waiting_drivers';
        // NEW: Post ride for driver HTML - driver HTML already okay, it reads this table
        const { data: ride } = await supabase.from('rides').insert([{ customer_phone: from, customer_name: u.name, pickup: u.pickup, destination: u.destination, city: u.city, distance_km: u.km, price_min: u.totalMin, price_max: u.totalMax, status: 'open' }]).select().single();
        u.rideId = ride?.id;
        await reply(`✅ Booking confirmed! Posting to drivers now...\n\n${u.pickup} → ${u.destination}\n${u.km}km = $${u.totalMin} - $${u.totalMax}\n\nDrivers have 3 mins to bid (first 5, cheapest first). I will send you the drivers now.`);
        if (OWNER_NUMBER) {
          try { await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `🚨 NEW BOOKING - My Chauffeur Zim\n\nName: ${u.name}\nPhone: ${from}\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km}km\nPrice: $${u.totalMin} - $${u.totalMax} (MIN/MAX)\nRide ID: ${u.rideId}\n\nDrivers bidding now on website.` }); }
          catch (e) { console.log('Owner notify error:', e.message); }
        }
        // After 3 mins, fetch first 5 bids from driver website and send to customer
        setTimeout(async () => {
          try {
            const { data: bids } = await supabase.from('bids').select('*').eq('ride_id', u.rideId).order('price', { ascending: true }).limit(5);
            if (!bids || bids.length === 0) {
              await sock.sendMessage(from, { text: `Sorry, no drivers bid in 3 mins. Type 1 to try again.` });
              u.step = 'menu'; return;
            }
            u.bids = bids; u.step = 'choose_driver';
            let list = `✅ ${bids.length} Drivers Available - Cheapest First:\n\n`;
            bids.forEach((b,i) => { list += `${i+1} - ${b.driver_name} - ${b.plate} - ${b.distance_km}km = $${Number(b.price).toFixed(2)} ${Number(b.price) <= Number(u.totalMin)+0.01 ? '(No fee - MIN)' : '(With fee)'}\n`; });
            list += `\nReply 1, 2, 3... to choose your driver.`;
            await sock.sendMessage(from, { text: list });
          } catch(e){ console.log('Bids fetch error', e.message); }
        }, 180000); // 3 mins
        return;
      }
      // NEW: Customer chooses driver
      if (u.step === 'choose_driver') {
        const idx = parseInt(text) - 1;
        if (!isNaN(idx) && u.bids && u.bids[idx]) {
          const chosen = u.bids[idx];
          // Validate MIN/MAX - block cheating driver even if website allowed it
          const check = validateBid(u.km, Number(chosen.price));
          if (!check.ok) { return await reply(`That bid was blocked: ${check.reason}. Choose another driver.`); }
          u.step = 'menu';
          await supabase.from('rides').update({ status: 'matched', chosen_driver: chosen.driver_name }).eq('id', u.rideId);
          return await reply(`✅ You chose ${chosen.driver_name} - ${chosen.plate}\n\n${u.pickup} → ${u.destination}\n${u.km}km = $${Number(chosen.price).toFixed(2)}\n\nDriver number: ${chosen.driver_phone}\nCall / WhatsApp them now to confirm.\n\nType 1 for another booking.`);
        }
        return await reply(`Reply 1 to ${u.bids?.length || 5} to choose a driver.`);
      }
    } catch (e) { console.log('Message error:', e.message); }
  });
}

console.log('Starting My Chauffeur Zim Bot with Baileys...');
console.log('Pairing for number:', PHONE_NUMBER);
startBot();
