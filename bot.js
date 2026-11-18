// My Chauffeur Zim - bot.js - PAIRING CODE VERSION
// Pricing: Day $1.50/km | Night from 8pm $2.00/km for driver safety
// Maps: Nominatim + Photon, OSRM + Valhalla

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');

const PHONE_NUMBER = process.env.PHONE_NUMBER || '263783264675'; // YOUR WhatsApp Business number, no +

// --- TIME: Harare ---
function getHarareHour() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Harare' })).getHours();
}
function isNight() { return getHarareHour() >= 20; }

// --- PRICING ---
function calculatePrice(km) {
  const night = isNight();
  const fareRate = 1.00;
  const feeRate = night ? 1.00 : 0.50;
  const perKm = fareRate + feeRate;
  return { km, night, fareRate, feeRate, perKm, fare: fareRate * km, fee: feeRate * km, total: perKm * km };
}
function formatPrice(pickup, dropoff, km, when, name) {
  const p = calculatePrice(km);
  const feeLine = p.night
    ? `Driver fee: $1.00 x ${km.toFixed(1)}km = $${p.fee.toFixed(2)} (Night fee from 8pm for driver safety)`
    : `Driver fee: $0.50 x ${km.toFixed(1)}km = $${p.fee.toFixed(2)}`;
  return `💰 *Price Estimate*\n\nFrom: ${pickup}\nTo: ${dropoff}\nWhen: ${when}\nName: ${name}\nDistance: ${km.toFixed(1)}km (road distance)\n\nFare: $1.00 x ${km.toFixed(1)}km = $${p.fare.toFixed(2)}\n${feeLine}\nTotal: $${p.total.toFixed(2)} ($${p.perKm.toFixed(2)} per km)\n\nDriver fee is $0.50 per km before 8pm, $1.00 per km from 8pm for driver safety.\n\nReply *YES* to confirm, or *NO* to cancel.`;
}

// --- MAPS ---
async function geocodeNominatim(place) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place + ', Zimbabwe')}&limit=1&countrycodes=zw`;
    const res = await axios.get(url, { headers: { 'User-Agent': 'MyChauffeurZim/1.0' }, timeout: 8000 });
    if (res.data[0]) return { lat: parseFloat(res.data[0].lat), lon: parseFloat(res.data[0].lon), src: 'Nominatim' };
  } catch (e) { console.log('Nominatim fail', e.message); }
  return null;
}
async function geocodePhoton(place) {
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(place + ', Zimbabwe')}&limit=1`;
    const res = await axios.get(url, { timeout: 8000 });
    if (res.data.features?.[0]) {
      const c = res.data.features[0].geometry.coordinates;
      return { lon: c[0], lat: c[1], src: 'Photon' };
    }
  } catch (e) { console.log('Photon fail', e.message); }
  return null;
}
async function geocode(place) {
  return (await geocodeNominatim(place)) || (await geocodePhoton(place)) || null;
}
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function osrmKm(a, b) {
  try {
    const res = await axios.get(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`, { timeout: 8000 });
    if (res.data.routes?.[0]?.distance) return res.data.routes[0].distance / 1000;
  } catch (e) { console.log('OSRM fail', e.message); }
  return null;
}
async function valhallaKm(a, b) {
  try {
    const res = await axios.post('https://valhalla1.openstreetmap.de/route', {
      locations: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
      costing: 'auto'
    }, { timeout: 8000 });
    if (res.data.trip?.summary?.length) return res.data.trip.summary.length;
  } catch (e) { console.log('Valhalla fail', e.message); }
  return null;
}
async function getRoadDistanceKm(pickup, dropoff) {
  const a = await geocode(pickup);
  const b = await geocode(dropoff);
  if (!a || !b) return null;
  console.log(`Geocoded: ${pickup} -> ${a.lat},${a.lon} (${a.src}) | ${dropoff} -> ${b.lat},${b.lon} (${b.src})`);
  let km = await osrmKm(a, b);
  if (km) { console.log('OSRM distance', km); return km; }
  km = await valhallaKm(a, b);
  if (km) { console.log('Valhalla distance', km); return km; }
  return haversineKm(a, b) * 1.35;
}

// --- BOT ---
const sessions = new Map();
const WELCOME = `👋 *Welcome to My Chauffeur Zim!*\n\nHow can we help you today?\n\nType *1* to Book a Ride 🚖\nType *2* for Prices 💰\nType *3* for Support 📞`;
const PRICES = `💰 *My Chauffeur Zim Prices*\n\nDay (before 8pm): *$1.50 per km*\n$1.00 fare + $0.50 driver fee per km\n\nNight (from 8pm): *$2.00 per km*\n$1.00 fare + $1.00 driver fee per km for driver safety\n\nExample: 10km = $15.00 day / $20.00 night\n\nBot calculates road distance between pickup and drop-off automatically.\n\nType *1* to Book a Ride`;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, logger: pino({ level: 'silent' }), auth: state, printQRInTerminal: false, browser: ['My Chauffeur Zim', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);

  // *** PAIRING CODE LOGIC - THIS WAS MISSING BEFORE ***
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('====================================');
        console.log(`PAIRING CODE FOR ${PHONE_NUMBER}: ${code}`);
        console.log('Go to WhatsApp Business > Linked Devices > Link with phone number > Enter this code');
        console.log('====================================');
      } catch (e) {
        console.log('Pairing code failed:', e.message);
        console.log('Make sure PHONE_NUMBER is correct and number is not already linked to another bot.');
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'close') {
      const shouldReconnect = u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnect?', shouldReconnect);
      if (shouldReconnect) start();
    } else if (u.connection === 'open') console.log('✅ Bot connected - My Chauffeur Zim is LIVE');
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;
    const from = m.key.remoteJid;
    const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
    if (!text) return;
    const lower = text.toLowerCase();
    let s = sessions.get(from);
    if (!s) { s = { step: 'menu' }; sessions.set(from, s); }
    const send = (t) => sock.sendMessage(from, { text: t });

    if (lower === 'hi' || lower === 'hello' || lower === 'menu') { s.step = 'menu'; return send(WELCOME); }
    if (s.step === 'menu') {
      if (text === '1') { s.step = 'pickup'; return send(`🚖 *Book a Ride*\n\nWhere should we pick you up from?`); }
      if (text === '2') return send(PRICES);
      if (text === '3') return send(`📞 *Support*\n\nCall / WhatsApp: +263 78 326 4675\n\nType *hi* to go back to menu`);
      return send(WELCOME);
    }
    if (s.step === 'pickup') { s.pickup = text; s.step = 'dropoff'; return send(`Great. Where are you going to?`); }
    if (s.step === 'dropoff') { s.dropoff = text; s.step = 'when'; return send(`When do you need the ride? (e.g. Today 2pm / Tomorrow 9am)`); }
    if (s.step === 'when') { s.when = text; s.step = 'name'; return send(`What is your name?`); }
    if (s.step === 'name') {
      s.name = text;
      await send(`Calculating road distance from ${s.pickup} to ${s.dropoff}... Please wait ⏳`);
      const km = await getRoadDistanceKm(s.pickup, s.dropoff);
      if (!km || km < 0.5 || km > 200) {
        s.step = 'menu';
        return send(`Sorry, I couldn't find that route. Please send clearer places (e.g. Paddonhurst, Bulawayo to City Hall, Bulawayo).\n\nType *hi* to try again`);
      }
      s.km = km;
      s.step = 'confirm';
      return send(formatPrice(s.pickup, s.dropoff, km, s.when, s.name));
    }
    if (s.step === 'confirm') {
      if (lower === 'yes') {
        const p = calculatePrice(s.km);
        s.step = 'menu';
        return send(`Thanks ${s.name}! We got your request. ✅\n\n${s.pickup} → ${s.dropoff}\n${s.km.toFixed(1)}km = $${p.total.toFixed(2)}\nWhen: ${s.when}\n\nWe will confirm shortly.\n\nType *hi* to go back to menu`);
      }
      if (lower === 'no') { s.step = 'menu'; return send(`No problem. Cancelled.\n\nType *hi* to go back to menu`); }
      return send(`Reply *YES* to confirm or *NO* to cancel.`);
    }
  });
}
start();
