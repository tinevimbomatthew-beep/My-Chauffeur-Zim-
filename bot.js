global.WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

let pairingRequested = false;
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

client.on('qr', async () => {
  if (pairingRequested) return;
  pairingRequested = true;
  const phone = process.env.PHONE_NUMBER;
  try {
    const code = await client.requestPairingCode(phone);
    console.log('YOUR PAIRING CODE IS:', code);
  } catch (err) {
    console.log('Pairing code error:', err.message);
    pairingRequested = false;
  }
});

client.on('ready', () => console.log('My Chauffeur Zim Bot is ready!'));
client.on('auth_failure', (m) => console.log('Auth failure:', m));

client.on('message', async (msg) => {
  try {
    const from = msg.from;
    const text = msg.body.trim().toLowerCase();
    if (!users[from]) users[from] = { step: 'menu' };
    const u = users[from];

    if (text === 'hi' || text === 'hello' || text === 'start' || text === 'menu') {
      u.step = 'menu';
      return await msg.reply(WELCOME);
    }

    if (u.step === 'menu') {
      if (text === '1') {
        u.step = 'pickup';
        return await msg.reply('Great! Let\'s book your ride 🚕\n\nWhere should we pick you up? Send your pickup location.');
      }
      if (text === '2') {
        return await msg.reply(PRICES);
      }
      if (text === '3') {
        return await msg.reply('📞 Support\n\nCall / WhatsApp us on 0783 264 675\n\nType 1 to Book a Ride');
      }
    }

    if (u.step === 'pickup') {
      u.pickup = msg.body.trim();
      u.step = 'destination';
      return await msg.reply(`Pickup: ${u.pickup}\n\nWhere are you going to? Send your destination.`);
    }

    if (u.step === 'destination') {
      u.destination = msg.body.trim();
      u.step = 'distance';
      return await msg.reply(`From: ${u.pickup}\nTo: ${u.destination}\n\nHow many kilometers is the trip? Just send the number, e.g. 10`);
    }

    if (u.step === 'distance') {
      const km = parseFloat(text);
      if (isNaN(km)) return await msg.reply('Please send just the number of kilometers, e.g. 10');

      const total = (km * 1.50).toFixed(2);

      await supabase.from('bookings').insert([{ phone: from, pickup: u.pickup, destination: u.destination, distance_km: km, price: total, status: 'pending' }]);

      u.step = 'menu';
      return await msg.reply(`✅ Price Estimate\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nDistance: ${km}km\n\nPricing: $1.00 per kilometer plus $0.50 driver fee making it a total of $1.50\n\nYour total: $${total}\n\nReply YES to confirm this booking, or type 1 to start again.`);
    }

    if (text === 'yes' && u.pickup) {
      return await msg.reply('✅ Booking confirmed! A driver will contact you shortly.\n\nType 1 for another booking.');
    }

  } catch (e) { console.log('Message error:', e.message); }
});

client.initialize();
