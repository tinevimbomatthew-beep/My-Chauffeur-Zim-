global.WebSocket = require('ws');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '263783264675').replace(/[^0-9]/g, '');
const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '263783264675').replace(/[^0-9]/g, '');

const users = {};

// --- PRICING: $1.00 per km + $0.50 driver fee = $1.50 total ---
const PER_KM = 1.00;
const DRIVER_FEE = 0.50;
const TOTAL_PER_KM = 1.50;

const WELCOME = `👋 Welcome to My Chauffeur Zim!

How can we help you today?

Type 1 to Book a Ride 🚕
Type 2 for Prices 💰
Type 3 for Support 📞`;

const PRICES = `💰 My Chauffeur Zim Prices - PRICE LIST

$1.00 per kilometer + $0.50 driver fee
= $1.50 total per kilometer

Examples:
5km = $7.50
10km = $15.00
15km = $22.50
20km = $30.00

No hidden fees. Same price day and night.

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
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['My Chauffeur Zim', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingInterval = null;

  // --- PAIRING CODE - NEW CODE EVERY 50 SEC ---
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

  // --- WEBSITE -> WHATSAPP BUSINESS ---
  // Website saves to Supabase 'bookings' with source='website', whatsapp_sent=false
  // Bot picks it up and sends it to your WhatsApp Business (OWNER_NUMBER)
  async function checkWebsiteBookings() {
    try {
      const { data } = await supabase.from('bookings').select('*').eq('source', 'website').eq('whatsapp_sent', false).order('created_at', { ascending: true }).limit(5);
      if (!data || !data.length) return;
      for (const b of data) {
        const msg = `🌐 NEW WEBSITE BOOKING - My Chauffeur Zim\n\nName: ${b.customer_name}\nPhone: ${b.phone}\nFrom: ${b.pickup}\nTo: ${b.destination}\nCity: ${b.city}\nDistance: ${b.distance_km}km\nTotal: $${b.price}\nBooking ID: ${b.id}\n\nReply to customer on WhatsApp now.`;
        try {
          await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: msg });
          // Also send confirmation to the customer if we have their WhatsApp
          if (b.phone) {
            const custJid = String(b.phone).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            await sock.sendMessage(custJid, { text: `✅ We got your website booking!\n\n${b.pickup} → ${b.destination}\n${b.distance_km}km = $${b.price}\n\nA driver will contact you shortly. Type 1 to book again.` });
          }
          await supabase.from('bookings').update({ whatsapp_sent: true }).eq('id', b.id);
          console.log('Website booking sent to WhatsApp:', b.id);
        } catch (e) { console.log('Website booking send error:', e.message); }
      }
    } catch (e) { console.log('Website check error:', e.message); }
  }
  setInterval(checkWebsiteBookings, 20000); // check every 20 sec

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      if (pairingInterval) clearInterval(pairingInterval);
      const code = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut || code === 401;
      console.log('Connection closed, code:', code, 'loggedOut:', isLoggedOut);
      if (isLoggedOut) {
        try { fs.rmSync('/tmp/auth_baileys', { recursive: true, force: true }); } catch {}
      }
      setTimeout(() => startBot(), 3000);
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

      // --- CUSTOMER CHOOSES DRIVER ---
      if (u.step === 'choose_driver') {
        const idx = parseInt(text) - 1;
        if (!isNaN(idx) && u.drivers && u.drivers[idx]) {
          const d = u.drivers[idx];
          u.step = 'menu';
          await supabase.from('bookings').update({ status: 'matched', chosen_driver: d.driver_name, driver_phone: d.driver_phone }).eq('id', u.bookingId);

          await reply(`✅ You chose ${d.driver_name} - ${d.plate}\n\n${u.pickup} → ${u.destination}\n${u.km}km = $${u.total}\n\nDriver number: ${d.driver_phone}\nDriver will contact you now.\n\nType 1 for another booking.`);

          // --- CUSTOMER INFO -> SELECTED DRIVER ---
          const driverJid = String(d.driver_phone).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          try {
            await sock.sendMessage(driverJid, { text: `🚕 NEW JOB - You were chosen! - My Chauffeur Zim\n\nCustomer: ${u.name}\nCustomer Phone: ${u.customerPhone}\nCall / WhatsApp them NOW\n\nPickup: ${u.pickup}\nDestination: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km}km\nYour Price: $${u.total}\nBooking ID: ${u.bookingId}\n\nPlease contact customer immediately.` });
            console.log('Customer info sent to driver:', d.driver_name);
          } catch (e) {
            console.log('Could not WhatsApp driver:', e.message);
            await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `Driver ${d.driver_name} ${d.driver_phone} was chosen for Booking ${u.bookingId} but WhatsApp failed. Call driver manually. Customer: ${u.name} ${u.customerPhone}` });
          }
          return;
        }
        return await reply(`Reply 1 to ${u.drivers?.length || 3} to choose a driver.`);
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
          u.km = parseFloat(autoKm); u.total = (u.km * TOTAL_PER_KM).toFixed(2); u.step = 'distance_confirm';
          return await reply(`Distance Found!\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ~${u.km}km\nPrice: $1.00/km + $0.50 fee = $1.50/km\nTotal: $${u.total}\n\nReply YES to use ${u.km}km, or send a different number.`);
        } else {
          u.step = 'distance_manual';
          return await reply(`I couldn't auto-calculate it.\n\nHow many kilometers is the trip? Just send the number, e.g. 10`);
        }
      }
      if (u.step === 'distance_confirm') {
        if (text === 'yes') { u.step = 'name'; return await reply('Perfect! What is your name?'); }
        const km = parseFloat(text);
        if (!isNaN(km)) { u.km = km; u.total = (km * TOTAL_PER_KM).toFixed(2); u.step = 'name'; return await reply(`Got it, using ${km}km. Total $${u.total}\n\nWhat is your name?`); }
        return await reply('Reply YES to use that distance, or send a different number.');
      }
      if (u.step === 'distance_manual') {
        const km = parseFloat(text);
        if (isNaN(km)) return await reply('Please send just the number of kilometers, e.g. 10');
        u.km = km; u.total = (km * TOTAL_PER_KM).toFixed(2); u.step = 'name';
        return await reply(`Got it! Total $${u.total}\n\nWhat is your name?`);
      }
      if (u.step === 'name') {
        u.name = body.trim();
        u.customerPhone = from.replace('@s.whatsapp.net', '');
        u.step = 'confirm';
        return await reply(`✅ Price Estimate\n\nName: ${u.name}\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km}km\n\nPricing: $1.00 per kilometer + $0.50 driver fee = $1.50/km\n\nYour total: $${u.total}\n\nReply YES to confirm this booking, or type 1 to start again.`);
      }
      if (u.step === 'confirm' && text === 'yes') {
        // Save booking
        const { data: booking } = await supabase.from('bookings').insert([{ phone: from, customer_name: u.name, pickup: u.pickup, destination: u.destination, city: u.city, distance_km: u.km, price: u.total, status: 'pending', source: 'whatsapp', whatsapp_sent: true }]).select().single();
        u.bookingId = booking?.id;

        // Notify Owner / WhatsApp Business
        if (OWNER_NUMBER) {
          try { await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `🚨 NEW BOOKING - My Chauffeur Zim\n\nName: ${u.name}\nPhone: ${u.customerPhone}\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km}km\nTotal: $${u.total}\nBooking ID: ${u.bookingId}` }); } catch (e) {}
        }

        // Get drivers for customer to choose
        const { data: drivers } = await supabase.from('drivers').select('*').eq('city', u.city).eq('available', true).limit(5);
        // Fallback: if no city match, get any available drivers
        let list = drivers;
        if (!list || !list.length) {
          const { data: anyDrivers } = await supabase.from('drivers').select('*').eq('available', true).limit(5);
          list = anyDrivers;
        }
        if (!list || !list.length) {
          u.step = 'menu';
          return await reply(`✅ Booking confirmed! No drivers online right now, but we saved it. A driver will contact you shortly.\n\nType 1 for another booking.`);
        }
        u.drivers = list; u.step = 'choose_driver';
        let msg = `✅ Booking confirmed! Choose your driver:\n\n`;
        list.forEach((d, i) => { msg += `${i + 1} - ${d.driver_name} - ${d.plate} - $${u.total}\n`; });
        msg += `\nReply 1, 2, 3... to choose your driver.`;
        return await reply(msg);
      }
    } catch (e) { console.log('Message error:', e.message); }
  });
}

console.log('Starting My Chauffeur Zim Bot with Baileys...');
console.log('Pairing for number:', PHONE_NUMBER);
startBot();
