global.WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');

const users = {};

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

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: 'auth_wweb2' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu']
  }
});

let codeRequested = false;

client.on('qr', async () => {
  if (codeRequested) return;
  codeRequested = true;
  console.log('Pairing for number:', PHONE_NUMBER);
  try {
    const code = await client.requestPairingCode(PHONE_NUMBER, true);
    console.log('YOUR PAIRING CODE IS:', code);
    console.log('ENTER THIS CODE NOW - DO NOT WAIT FOR ANOTHER CODE');
  } catch (e) {
    console.log('Pairing error FULL:', e);
    codeRequested = false;
  }
});

client.on('ready', () => {
  console.log('My Chauffeur Zim Bot is ready!');
});

client.on('auth_failure', (msg) => { console.log('Auth failure:', msg); });
client.on('disconnected', (reason) => { console.log('Disconnected:', reason); });

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const from = msg.from;
    const body = msg.body || '';
    const text = body.trim().toLowerCase();
    const reply = async (txt) => { await msg.reply(txt); };
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
        u.km = parseFloat(autoKm); u.total = (u.km * 1.50).toFixed(2); u.step = 'distance_confirm';
        return await reply(`Distance Found!\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ~${u.km}km\n\nReply YES to use ${u.km}km, or send a different number.\n\nNo need to open any map - you can book right here on WhatsApp.`);
      } else {
        u.step = 'distance_manual';
        return await reply(`I couldn't auto-calculate it.\n\nHow many kilometers is the trip? Just send the number, e.g. 10\n\nNo need to open any map - just type the number here on WhatsApp.`);
      }
    }
    if (u.step === 'distance_confirm') {
      if (text === 'yes') { u.step = 'name'; return await reply('Perfect! What is your name?'); }
      const km = parseFloat(text);
      if (!isNaN(km)) { u.km = km; u.total = (km * 1.50).toFixed(2); u.step = 'name'; return await reply(`Got it, using ${km}km.\n\nWhat is your name?`); }
      return await reply('Reply YES to use that distance, or send a different number.');
    }
    if (u.step === 'distance_manual') {
      const km = parseFloat(text);
      if (isNaN(km)) return await reply('Please send just the number of kilometers, e.g. 10');
      u.km = km; u.total = (km * 1.50).toFixed(2); u.step = 'name';
      return await reply('Got it! What is your name?');
    }
    if (u.step === 'name') {
      u.name = body.trim(); u.step = 'confirm';
      await supabase.from('bookings').insert([{ phone: from, customer_name: u.name, pickup: u.pickup, destination: u.destination, city: u.city, distance_km: u.km, price: u.total, status: 'pending' }]);
      return await reply(`✅ Price Estimate\n\nName: ${u.name}\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km}km\n\nPricing: $1.00 per kilometer plus $0.50 driver fee making it a total of $1.50\n\nYour total: $${u.total}\n\nReply YES to confirm this booking, or type 1 to start again.`);
    }
    if (u.step === 'confirm' && text === 'yes') {
      u.step = 'menu';
      await reply('✅ Booking confirmed! A driver will contact you shortly.\n\nType 1 for another booking.');
      if (OWNER_NUMBER) {
        try { await client.sendMessage(OWNER_NUMBER + '@c.us', `🚨 NEW BOOKING - My Chauffeur Zim\n\nName: ${u.name}\nPhone: ${from}\nFrom: ${u.pickup}\nTo: ${u.destination}\nCity: ${u.city}\nDistance: ${u.km}km\nTotal: $${u.total}\n\nCall them to confirm driver.`); }
        catch (e) { console.log('Owner notify error:', e.message); }
      }
      return;
    }
  } catch (e) { console.log('Message error:', e.message); }
});

console.log('Starting My Chauffeur Zim Bot with whatsapp-web.js...');
console.log('Pairing for number:', PHONE_NUMBER);
client.initialize();
