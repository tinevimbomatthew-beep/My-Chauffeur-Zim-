console.log('=== STARTING MY CHAUFFEUR ZIM BOT ===');
console.log('Time:', new Date().toISOString());
console.log('PHONE_NUMBER env:', process.env.PHONE_NUMBER || 'NOT SET - using default');

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');

const PHONE_NUMBER = (process.env.PHONE_NUMBER || '263783264675').replace(/[^0-9]/g, '');
console.log('Using phone:', PHONE_NUMBER);

// --- TIME ---
function getHarareHour() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Harare' })).getHours();
}
function isNight() { return getHarareHour() >= 20; }

// --- PRICING: Day $1.50/km, Night $2.00/km ---
function calculatePrice(km) {
  const night = isNight();
  const feeRate = night ? 1.00 : 0.50;
  const perKm = 1.00 + feeRate;
  return { night, feeRate, perKm, fare: 1.00 * km, fee: feeRate * km, total: perKm * km };
}
function formatPrice(pickup, dropoff, km, when, name) {
  const p = calculatePrice(km);
  const feeLine = p.night
    ? `Driver fee: $1.00 x ${km.toFixed(1)}km = $${p.fee.toFixed(2)} (Night fee from 8pm for driver safety)`
    : `Driver fee: $0.50 x ${km.toFixed(1)}km = $${p.fee.toFixed(2)}`;
  return `💰 *Price Estimate*\n\nFrom: ${pickup}\nTo: ${dropoff}\nWhen: ${when}\nName: ${name}\nDistance: ${km.toFixed(1)}km (road distance)\n\nFare: $1.00 x ${km.toFixed(1)}km = $${p.fare.toFixed(2)}\n${feeLine}\nTotal: $${p.total.toFixed(2)} ($${p.perKm.toFixed(2)} per km)\n\nDriver fee is $0.50 per km before 8pm, $1.00 per km from 8pm for driver safety.\n\nReply *YES* to confirm, or *NO* to cancel.`;
}

// --- MAPS ---
async function geocode(place) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place + ', Zimbabwe')}&limit=1&countrycodes=zw`;
    const r = await axios.get(url, { headers: { 'User-Agent': 'MyChauffeurZim/1.0' }, timeout: 8000 });
    if (r.data[0]) return { lat: parseFloat(r.data[0].lat), lon: parseFloat(r.data[0].lon) };
  } catch (e) { console.log('Nominatim fail', e.message); }
  try {
    const r2 = await axios.get(`https://photon.komoot.io/api/?q=${encodeURIComponent(place + ', Zimbabwe')}&limit=1`, { timeout: 8000 });
    if (r2.data.features?.[0]) { const c = r2.data.features[0].geometry.coordinates; return { lon: c[0], lat: c[1] }; }
  } catch (e) { console.log('Photon fail', e.message); }
  return null;
}
function haversineKm(a, b) {
  const R = 6371; const dLat = (b.lat - a.lat) * Math.PI / 180; const dLon = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function getRoadDistanceKm(pickup, dropoff) {
  const a = await geocode(pickup); const b = await geocode(dropoff);
  if (!a || !b) return null;
  try {
    const r = await axios.get(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`, { timeout: 8000 });
    if (r.data.routes?.[0]?.distance) return r.data.routes[0].distance / 1000;
  } catch (e) { console.log('OSRM fail', e.message); }
  try {
    const r2 = await axios.post('https://valhalla1.openstreetmap.de/route', { locations: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }], costing: 'auto' }, { timeout: 8000 });
    if (r2.data.trip?.summary?.length) return r2.data.trip.summary.length;
  } catch (e) { console.log('Valhalla fail', e.message); }
  return haversineKm(a, b) * 1.35;
}

// --- BOT ---
const sessions = new Map();
const WELCOME = `👋 *Welcome to My Chauffeur Zim!*\n\nHow can we help you today?\n\nType *1* to Book a Ride 🚖\nType *2* for Prices 💰\nType *3* for Support 📞`;
const PRICES = `💰 *My Chauffeur Zim Prices*\n\nDay (before 8pm): *$1.50 per km*\n$1.00 fare + $0.50 driver fee per km\n\nNight (from 8pm): *$2.00 per km*\n$1.00 fare + $1.00 driver fee per km for driver safety\n\nExample: 10km = $15.00 day / $20.00 night\n\nBot calculates road distance between pickup and drop-off automatically.\n\nType *1* to Book a Ride`;

async function start() {
  console.log('Connecting to WhatsApp...');
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, logger: pino({ level: 'silent' }), auth: state, printQRInTerminal: false, browser: ['My Chauffeur Zim', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);

  // *** PAIRING CODE EVERY 60 SECONDS ***
  let pairingInterval = null;
  async function askForCode() {
    if (sock.authState.creds.registered) {
      if (pairingInterval) clearInterval(pairingInterval);
      return;
    }
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log('====================================');
      console.log(`>>> PAIRING CODE: ${code} <<<`);
      console.log(`For number: ${PHONE_NUMBER}`);
      console.log('Enter in WhatsApp Business > Linked Devices > Link with phone number');
      console.log('This code expires in 60 seconds - new code coming...');
      console.log('====================================');
    } catch (e) {
      console.log('Pairing failed:', e.message);
    }
  }
  if (!sock.authState.creds.registered) {
    console.log('Not registered yet - will request pairing code...');
    setTimeout(askForCode, 2000);
    pairingInterval = setInterval(askForCode, 60000); // every 60s
  }

  sock.ev.on('connection.update', (u) => {
    console.log('Connection update:', u.connection);
    if (u.connection === 'close') {
      const shouldReconnect = u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Closed, reconnect?', shouldReconnect);
      if (shouldReconnect) start();
    } else if (u.connection === 'open') {
      console.log('✅ Bot connected - My Chauffeur Zim is LIVE');
      if (pairingInterval) clearInterval(pairingInterval);
    }
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
      if (!km || km < 0.5 || km > 200) { s.step = 'menu'; return send(`Sorry, I couldn't find that route. Please send clearer places (e.g. Paddonhurst, Bulawayo to City Hall, Bulawayo).\n\nType *hi* to try again`); }
      s.km = km; s.step = 'confirm';
      return send(formatPrice(s.pickup, s.dropoff, km, s.when, s.name));
    }
    if (s.step === 'confirm') {
      if (lower === 'yes') {
        const p = calculatePrice(s.km); s.step = 'menu';
        return send(`Thanks ${s.name}! We got your request. ✅\n\n${s.pickup} → ${s.dropoff}\n${s.km.toFixed(1)}km = $${p.total.toFixed(2)}\nWhen: ${s.when}\n\nWe will confirm shortly.\n\nType *hi* to go back to menu`);
      }
      if (lower === 'no') { s.step = 'menu'; return send(`No problem. Cancelled.\n\nType *hi* to go back to menu`); }
      return send(`Reply *YES* to confirm or *NO* to cancel.`);
    }
  });
}
start();
