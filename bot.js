const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '263783264675').replace(/[^0-9]/g, '');
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '263783264675').replace(/[^0-9]/g, '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const users = {};

// --- PRICES: Day 6am-8pm, Night 8pm-6am ---
function getPrices() {
  const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Harare' })).getHours();
  const isNight = hour >= 20 || hour < 6;
  if (isNight) return { isNight: true, label: '🌙 NIGHT (8pm - 6am)', farePerKm: 0.75, driverFee: 0.75 };
  return { isNight: false, label: '☀️ DAY (6am - 8pm)', farePerKm: 0.50, driverFee: 0.50 };
}
function calc(km) {
  const p = getPrices();
  const fare = km * p.farePerKm;
  const total = fare + p.driverFee;
  return { ...p, fare, total, minTotal: total, maxTotal: total };
}

const WELCOME = `👋 Welcome to My Chauffeur Zim!

Type 1 to Get Price / Book 🚕
Type 2 for Prices 💰`;

const PRICES_MSG = () => {
  const p = getPrices();
  return `💰 My Chauffeur Zim Prices

${p.label} - RIGHT NOW

DAY (6am - 8pm):
Fare: $0.50 per km
Driver Fee: $0.50
Example 10km = $5.50

NIGHT (8pm - 6am):
Fare: $0.75 per km
Driver Fee: $0.75
Example 10km = $8.25

Night 8pm-6am, then back to Day automatically.

Type 1 to Book`;
};

// --- FIX 1: TimeoutError fix - longer timeouts, no crash ---
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: 'auth_wwebjs' }),
  puppeteer: {
    headless: true,
    timeout: 120000, // was 30000, now 120s
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu', '--disable-extensions']
  }
});

// --- FIX 2: Pairing code auto-refresh = 60+ sec window ---
// WhatsApp only allows 20 sec per code, so we request a NEW code every 20 sec
// You get unlimited tries for 60+ sec, no redeploy needed
let pairingTimer = null;
let pairingActive = false;

async function requestFreshCode() {
  if (!pairingActive) return;
  try {
    const code = await client.requestPairingCode(PHONE_NUMBER);
    console.log('======================================');
    console.log('YOUR PAIRING CODE IS:', code);
    console.log('Valid for ~20 sec - NEW code coming in 20 sec if you miss it');
    console.log('WhatsApp > Linked Devices > Link with phone number');
    console.log('Phone:', PHONE_NUMBER);
    console.log('======================================');
  } catch (e) {
    console.log('Pairing code error (will retry in 20s):', e.message);
  }
}

client.on('qr', async () => {
  console.log('QR event - starting pairing code auto-refresh (60+ sec window)');
  if (!pairingActive) {
    pairingActive = true;
    await requestFreshCode();
    // Refresh every 20 sec = you always have a fresh code
    pairingTimer = setInterval(requestFreshCode, 20000);
  }
});

client.on('authenticated', () => {
  console.log('My Chauffeur Zim Bot - AUTHENTICATED!');
  pairingActive = false;
  if (pairingTimer) clearInterval(pairingTimer);
});

client.on('ready', () => {
  console.log('My Chauffeur Zim Bot is ready!');
  pairingActive = false;
  if (pairingTimer) clearInterval(pairingTimer);
});

client.on('auth_failure', (msg) => { console.log('Auth failed:', msg); });
client.on('disconnected', (reason) => { console.log('Disconnected:', reason); });

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const from = msg.from; // e.g. 26377xxxx@c.us
    const body = (msg.body || '').trim();
    const text = body.toLowerCase();
    if (!users[from]) users[from] = { step: 'menu' };
    const u = users[from];
    const reply = async (txt) => { await client.sendMessage(from, txt); };

    if (text === 'hi' || text === 'hello' || text === 'start' || text === 'menu') {
      u.step = 'menu';
      return await reply(WELCOME);
    }

    if (u.step === 'menu') {
      if (text === '1') { u.step = 'pickup'; return await reply('Let\'s get your price 🚕\n\nWhere should we pick you up?'); }
      if (text === '2') return await reply(PRICES_MSG());
    }

    if (u.step === 'pickup') { u.pickup = body; u.step = 'destination'; return await reply(`Pickup: ${u.pickup}\n\nWhere are you going to?`); }
    if (u.step === 'destination') { u.destination = body; u.step = 'km'; return await reply(`From: ${u.pickup}\nTo: ${u.destination}\n\nHow many kilometers? Send number, e.g. 10`); }

    if (u.step === 'km') {
      const km = parseFloat(text);
      if (isNaN(km)) return await reply('Please send just the number, e.g. 10');
      const c = calc(km);
      u.km = km; u.fare = c.fare; u.total = c.total; u.priceLabel = c.label;
      u.step = 'name';
      return await reply(`✅ Your Price - My Chauffeur Zim\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nDistance: ${km}km\n${c.label}\n\nFare: ${km}km x $${c.farePerKm.toFixed(2)} = $${c.fare.toFixed(2)}\nDriver Fee: $${c.driverFee.toFixed(2)}\nTOTAL: $${c.total.toFixed(2)}\n\nWhat is your name?`);
    }

    if (u.step === 'name') {
      u.name = body;
      u.customerPhone = from.replace('@c.us', '');
      u.step = 'confirm';
      return await reply(`Name: ${u.name}\nFrom: ${u.pickup}\nTo: ${u.destination}\n${u.km}km = $${u.total.toFixed(2)}\n\nReply YES to confirm and send to drivers, or type 1 to start again.`);
    }

    // --- CONFIRM -> CREATE RIDE IN SUPABASE -> DRIVERS BID ---
    if (u.step === 'confirm' && text === 'yes') {
      u.step = 'waiting_drivers';
      const { data: ride, error } = await supabase.from('rides').insert([{
        customer_phone: u.customerPhone,
        customer_name: u.name,
        pickup: u.pickup,
        destination: u.destination,
        city: 'Zimbabwe',
        distance_km: u.km,
        price_min: u.total,
        price_max: u.total,
        status: 'open'
      }]).select().single();

      if (error) {
        console.log('Ride insert error:', error.message);
        u.step = 'menu';
        return await reply('Sorry, could not post to drivers. Type 1 to try again.');
      }

      u.rideId = ride.id;
      await reply(`✅ Booking confirmed! Posting to drivers...\n\n${u.pickup} → ${u.destination}\n${u.km}km = $${u.total.toFixed(2)}\n\nDrivers have 2 mins to bid. I will send you the top 5 cheapest.`);

      // Notify owner
      try { await client.sendMessage(OWNER_NUMBER + '@c.us', `🚨 NEW BOOKING\nName: ${u.name}\nPhone: ${u.customerPhone}\nFrom: ${u.pickup}\nTo: ${u.destination}\n${u.km}km = $${u.total.toFixed(2)}\nRide ID: ${u.rideId}`); } catch(e){}

      // --- AFTER 2 MINS: TAKE FIRST 5 PRICES FROM DRIVER WEBSITE ---
      setTimeout(async () => {
        try {
          const { data: bids } = await supabase.from('bids')
            .select('*')
            .eq('ride_id', u.rideId)
            .order('price', { ascending: true })
            .limit(5);

          if (!bids || bids.length === 0) {
            await client.sendMessage(from, `Sorry, no drivers bid in 2 mins. Type 1 to try again.`);
            u.step = 'menu'; return;
          }

          u.bids = bids; u.step = 'choose_driver';
          let list = `✅ ${bids.length} Drivers Available - Cheapest First:\n\n`;
          bids.forEach((b, i) => {
            list += `${i+1} - ${b.driver_name} - ${b.plate} - $${Number(b.price).toFixed(2)}\n`;
          });
          list += `\nReply 1, 2, 3... to choose your driver.`;
          await client.sendMessage(from, list);
        } catch (e) { console.log('Bids fetch error:', e.message); }
      }, 120000); // 2 mins
      return;
    }

    // --- CUSTOMER CHOOSES DRIVER -> SEND CUSTOMER DETAILS TO THAT DRIVER ---
    if (u.step === 'choose_driver') {
      const idx = parseInt(text) - 1;
      if (!isNaN(idx) && u.bids && u.bids[idx]) {
        const chosen = u.bids[idx];
        u.step = 'menu';
        await supabase.from('rides').update({ status: 'matched', chosen_driver: chosen.driver_name }).eq('id', u.rideId);

        // 1. Tell customer
        await reply(`✅ You chose ${chosen.driver_name} - ${chosen.plate}\n\n${u.pickup} → ${u.destination}\n${u.km}km = $${Number(chosen.price).toFixed(2)}\n\nDriver number: ${chosen.driver_phone}\nDriver will contact you now.\n\nType 1 for another booking.`);

        // 2. Send customer details to SELECTED driver on WhatsApp
        const driverChatId = String(chosen.driver_phone).replace(/[^0-9]/g, '') + '@c.us';
        try {
          await client.sendMessage(driverChatId,
            `🚕 NEW JOB - You were chosen! - My Chauffeur Zim\n\nCustomer: ${u.name}\nCustomer Phone: ${u.customerPhone}\nCall / WhatsApp them NOW\n\nPickup: ${u.pickup}\nDestination: ${u.destination}\nDistance: ${u.km}km\nYour Price: $${Number(chosen.price).toFixed(2)}\nRide ID: ${u.rideId}\n\nPlease contact customer immediately.`
          );
          console.log('Customer details sent to driver:', chosen.driver_name);
        } catch (e) {
          console.log('Could not WhatsApp driver, owner must call driver:', e.message);
          try { await client.sendMessage(OWNER_NUMBER + '@c.us', `Driver ${chosen.driver_name} ${chosen.driver_phone} was chosen for Ride ${u.rideId} but WhatsApp failed. Call driver manually. Customer: ${u.name} ${u.customerPhone}`); } catch(_){}
        }
        return;
      }
      return await reply(`Reply 1 to ${u.bids?.length || 5} to choose a driver.`);
    }

  } catch (e) { console.log('Message error:', e.message); }
});

// Catch TimeoutError crash - don't let bot die
process.on('unhandledRejection', (e) => { console.log('Unhandled (ignored, bot keeps running):', e.message); });

console.log('Starting My Chauffeur Zim Bot - WhatsApp Web.js - Pairing Code Only...');
console.log('Phone for pairing:', PHONE_NUMBER);
client.initialize();
