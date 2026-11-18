global.WebSocket = require('ws');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '263783264675').replace(/[^0-9]/g, '');
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '263783264675').replace(/[^0-9]/g, '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const users = {};

// --- PRICES ---
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
  return { ...p, fare, total };
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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['My Chauffeur Zim', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingTimer = null;
  let pairingStarted = false;

  async function askForCode() {
    if (sock.authState.creds.registered) {
      if (pairingTimer) clearInterval(pairingTimer);
      return;
    }
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log('======================================');
      console.log('YOUR_PAIRING_CODE_IS:' + code);
      console.log('WhatsApp>Linked_Devices>Link_with_phone_number');
      console.log('Phone:' + PHONE_NUMBER);
      console.log('Type this code NOW - new code in 65 sec');
      console.log('======================================');
    } catch (e) {
      console.log('PAIRING_FAIL:' + e.message + ' - will retry in 65 sec');
    }
  }

  function startPairingLoop() {
    if (pairingStarted) return;
    pairingStarted = true;
    console.log('Not registered yet - starting pairing code loop...');
    askForCode();
    pairingTimer = setInterval(askForCode, 65000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    console.log('CONNECTION_STATUS:' + connection);

    if (connection === 'close') {
      if (pairingTimer) clearInterval(pairingTimer);
      pairingStarted = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:' + shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      } else {
        console.log('LOGGED OUT - delete auth_baileys volume in Railway and redeploy');
      }
    } else if (connection === 'open') {
      console.log('My Chauffeur Zim Bot is ready!');
      if (pairingTimer) clearInterval(pairingTimer);
    } else if (connection === 'connecting') {
      if (!sock.authState.creds.registered) {
        startPairingLoop();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const from = msg.key.remoteJid;
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const text = body.trim().toLowerCase();
      if (!users[from]) users[from] = { step: 'menu' };
      const u = users[from];
      const reply = async (txt) => { await sock.sendMessage(from, { text: txt }); };

      if (text === 'hi' || text === 'hello' || text === 'start' || text === 'menu') {
        u.step = 'menu';
        return await reply(WELCOME);
      }

      if (u.step === 'menu') {
        if (text === '1') { u.step = 'pickup'; return await reply('Let\'s get your price 🚕\n\nWhere should we pick you up?'); }
        if (text === '2') return await reply(PRICES_MSG());
      }

      if (u.step === 'pickup') { u.pickup = body.trim(); u.step = 'destination'; return await reply(`Pickup: ${u.pickup}\n\nWhere are you going to?`); }
      if (u.step === 'destination') { u.destination = body.trim(); u.step = 'km'; return await reply(`From: ${u.pickup}\nTo: ${u.destination}\n\nHow many kilometers? Send number, e.g. 10`); }

      if (u.step === 'km') {
        const km = parseFloat(text);
        if (isNaN(km)) return await reply('Please send just the number, e.g. 10');
        const c = calc(km);
        u.km = km; u.fare = c.fare; u.total = c.total;
        u.step = 'name';
        return await reply(`✅ Your Price - My Chauffeur Zim\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nDistance: ${km}km\n${c.label}\n\nFare: ${km}km x $${c.farePerKm.toFixed(2)} = $${c.fare.toFixed(2)}\nDriver Fee: $${c.driverFee.toFixed(2)}\nTOTAL: $${c.total.toFixed(2)}\n\nWhat is your name?`);
      }

      if (u.step === 'name') {
        u.name = body.trim();
        u.customerPhone = from.replace('@s.whatsapp.net', '');
        u.step = 'confirm';
        return await reply(`Name: ${u.name}\nFrom: ${u.pickup}\nTo: ${u.destination}\n${u.km}km = $${u.total.toFixed(2)}\n\nReply YES to confirm and send to drivers, or type 1 to start again.`);
      }

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
          console.log('Ride insert error:' + error.message);
          u.step = 'menu';
          return await reply('Sorry, could not post to drivers. Type 1 to try again.');
        }

        u.rideId = ride.id;
        await reply(`✅ Booking confirmed! Posting to drivers...\n\n${u.pickup} → ${u.destination}\n${u.km}km = $${u.total.toFixed(2)}\n\nDrivers have 2 mins to bid. I will send you the top 5 cheapest.`);

        try { await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `🚨 NEW BOOKING\nName: ${u.name}\nPhone: ${u.customerPhone}\nFrom: ${u.pickup}\nTo: ${u.destination}\n${u.km}km = $${u.total.toFixed(2)}\nRide ID: ${u.rideId}` }); } catch (e) {}

        setTimeout(async () => {
          try {
            const { data: bids } = await supabase.from('bids').select('*').eq('ride_id', u.rideId).order('price', { ascending: true }).limit(5);
            if (!bids || bids.length === 0) {
              await sock.sendMessage(from, { text: `Sorry, no drivers bid in 2 mins. Type 1 to try again.` });
              u.step = 'menu'; return;
            }
            u.bids = bids; u.step = 'choose_driver';
            let list = `✅ ${bids.length} Drivers Available - Cheapest First:\n\n`;
            bids.forEach((b, i) => { list += `${i + 1} - ${b.driver_name} - ${b.plate} - $${Number(b.price).toFixed(2)}\n`; });
            list += `\nReply 1, 2, 3... to choose your driver.`;
            await sock.sendMessage(from, { text: list });
          } catch (e) { console.log('Bids fetch error:' + e.message); }
        }, 120000);
        return;
      }

      if (u.step === 'choose_driver') {
        const idx = parseInt(text) - 1;
        if (!isNaN(idx) && u.bids && u.bids[idx]) {
          const chosen = u.bids[idx];
          u.step = 'menu';
          await supabase.from('rides').update({ status: 'matched', chosen_driver: chosen.driver_name }).eq('id', u.rideId);

          await reply(`✅ You chose ${chosen.driver_name} - ${chosen.plate}\n\n${u.pickup} → ${u.destination}\n${u.km}km = $${Number(chosen.price).toFixed(2)}\n\nDriver number: ${chosen.driver_phone}\nDriver will contact you now.\n\nType 1 for another booking.`);

          const driverChatId = String(chosen.driver_phone).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          try {
            await sock.sendMessage(driverChatId, { text: `🚕 NEW JOB - You were chosen! - My Chauffeur Zim\n\nCustomer: ${u.name}\nCustomer Phone: ${u.customerPhone}\nCall / WhatsApp them NOW\n\nPickup: ${u.pickup}\nDestination: ${u.destination}\nDistance: ${u.km}km\nYour Price: $${Number(chosen.price).toFixed(2)}\nRide ID: ${u.rideId}\n\nPlease contact customer immediately.` });
            console.log('Customer details sent to driver:' + chosen.driver_name);
          } catch (e) {
            console.log('Could not WhatsApp driver:' + e.message);
            try { await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `Driver ${chosen.driver_name} ${chosen.driver_phone} was chosen for Ride ${u.rideId} but WhatsApp failed. Call driver manually. Customer: ${u.name} ${u.customerPhone}` }); } catch (_) {}
          }
          return;
        }
        return await reply(`Reply 1 to ${u.bids?.length || 5} to choose a driver.`);
      }

    } catch (e) { console.log('Message error:' + e.message); }
  });
}

console.log('Starting My Chauffeur Zim Bot - Baileys - Pairing Code Only...');
console.log('Phone for pairing:' + PHONE_NUMBER);
startBot();
