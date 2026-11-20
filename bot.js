
// MY CHAUFFEUR ZIM — WHATSAPP BOOKING BOT V2
// Environment variables:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// PHONE_NUMBER
// OWNER_NUMBER
// BID_WINDOW_SECONDS (optional, default 90)

global.WebSocket = require('ws');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const fs = require('fs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '').replace(/\D/g, '');
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');

const BID_WINDOW_SECONDS = Number(process.env.BID_WINDOW_SECONDS || 90);
const AUTH_DIR = 'auth_baileys';

const users = new Map();
const offeredBookings = new Set();

const WELCOME = `👋 Welcome to My Chauffeur Zim!

How can we help you today?

1️⃣ Book a Ride 🚕
2️⃣ View Prices 💰
3️⃣ Support 📞

Type MENU to return here.`;

function money(amount) {
  return '$' + Number(amount).toFixed(2);
}

// ZIMBABWE TIME-BASED PRICING
function getRates() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Harare',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const hour = Number(parts.find(p => p.type === 'hour').value);

  if (hour >= 20 || hour < 5) {
    return {
      night: true,
      fare: 1.50,
      driverFee: 1.00
    };
  }

  return {
    night: false,
    fare: 1.00,
    driverFee: 0.50
  };
}

function calculatePrice(km) {
  const rates = getRates();

  return {
    night: rates.night,
    minimum: Number((km * rates.fare).toFixed(2)),
    maximum: Number((km * (rates.fare + rates.driverFee)).toFixed(2))
  };
}

// AUTOMATIC DISTANCE CALCULATION
async function geocode(place, city) {
  const url = new URL('https://nominatim.openstreetmap.org/search');

  url.searchParams.set(
    'q',
    `${place}, ${city}, Zimbabwe`
  );

  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'MyChauffeurZim/2.0'
    }
  });

  if (!response.ok) throw new Error('Geocoding failed');

  const data = await response.json();

  if (!data.length) return null;

  return {
    lat: data[0].lat,
    lon: data[0].lon
  };
}

async function getDistanceKm(pickup, destination, city) {
  try {
    const from = await geocode(pickup, city);

    if (!from) return null;

    // Respect Nominatim's public service request rate.
    await new Promise(resolve => setTimeout(resolve, 1100));

    const to = await geocode(destination, city);

    if (!to) return null;

    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;

    const response = await fetch(url);

    if (!response.ok) return null;

    const data = await response.json();

    if (!data.routes || !data.routes[0]) return null;

    return Number(
      (data.routes[0].distance / 1000).toFixed(1)
    );

  } catch (error) {
    console.log('Distance error:', error.message);
    return null;
  }
}

function phoneFromJid(jid) {
  return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

async function reply(sock, jid, text) {
  return sock.sendMessage(jid, { text });
}

async function notifyOwner(sock, text) {
  if (!OWNER_NUMBER) return;

  try {
    await sock.sendMessage(
      OWNER_NUMBER + '@s.whatsapp.net',
      { text }
    );
  } catch (error) {
    console.log('Owner notification:', error.message);
  }
}

function getText(message) {
  const m = message.message || {};

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    ''
  ).trim();
}

// BOOKING FLOW
async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

  const body = getText(msg);

  if (!body) return;

  const text = body.toLowerCase();

  let u = users.get(jid) || { step: 'menu' };

  if (['hi', 'hello', 'start', 'menu'].includes(text)) {
    users.set(jid, { step: 'menu' });
    return reply(sock, jid, WELCOME);
  }

  if (text === 'cancel') {
    if (u.bookingId) {
      await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', u.bookingId)
        .in('status', ['open', 'bidding']);
    }

    users.set(jid, { step: 'menu' });

    return reply(sock, jid, 'Booking cancelled. Type 1 to book again.');
  }

  if (u.step === 'menu') {
    if (text === '1') {
      u = { step: 'pickup' };
      users.set(jid, u);

      return reply(
        sock,
        jid,
        '🚕 Let us book your ride!\n\nWhere should we pick you up?'
      );
    }

    if (text === '2') {
      return reply(
        sock,
        jid,
        `💰 MY CHAUFFEUR ZIM PRICES

DAY: 5AM–8PM
Minimum: $1.00 per km
Maximum: $1.50 per km

NIGHT: 8PM–5AM
Minimum: $1.50 per km
Maximum: $2.50 per km

Minimum = fare only.
Maximum = fare plus driver fee.

The actual driver offer is shown before you select.

Type 1 to book.`
      );
    }

    if (text === '3') {
      return reply(
        sock,
        jid,
        '📞 Support\n\nCall / WhatsApp: 0783 264 675'
      );
    }

    return reply(sock, jid, WELCOME);
  }

  if (u.step === 'pickup') {
    u.pickup = body;
    u.step = 'destination';

    return reply(
      sock,
      jid,
      `Pickup: ${u.pickup}\n\nWhere are you going?`
    );
  }

  if (u.step === 'destination') {
    u.destination = body;
    u.step = 'city';

    return reply(
      sock,
      jid,
      `Destination: ${u.destination}\n\nWhich city is this trip in?`
    );
  }

  if (u.step === 'city') {
    u.city = body;
    u.step = 'calculating';

    await reply(sock, jid, '📍 Calculating driving distance...');

    const km = await getDistanceKm(
      u.pickup,
      u.destination,
      u.city
    );

    if (!km || km <= 0) {
      u.step = 'manual_distance';

      return reply(
        sock,
        jid,
        'Could not automatically find the route.\n\nPlease enter the distance in kilometres, e.g. 10.'
      );
    }

    u.km = km;
    u.prices = calculatePrice(km);
    u.step = 'name';

    return reply(
      sock,
      jid,
      `📍 ROUTE FOUND!

From: ${u.pickup}
To: ${u.destination}
City: ${u.city}

Distance: ${km} km

Minimum fare: ${money(u.prices.minimum)}
Maximum fare: ${money(u.prices.maximum)}

What is your full name?`
    );
  }

  if (u.step === 'manual_distance') {
    const km = Number(body);

    if (!Number.isFinite(km) || km <= 0 || km > 1000) {
      return reply(sock, jid, 'Please enter a valid distance, e.g. 10.');
    }

    u.km = Number(km.toFixed(1));
    u.prices = calculatePrice(u.km);
    u.step = 'name';

    return reply(sock, jid, 'What is your full name?');
  }

  if (u.step === 'name') {
    if (body.length < 2) {
      return reply(sock, jid, 'Please enter your full name.');
    }

    u.name = body;
    u.step = 'review';

    return reply(
      sock,
      jid,
      `🧾 RIDE SUMMARY

Name: ${u.name}
Pickup: ${u.pickup}
Destination: ${u.destination}
City: ${u.city}
Distance: ${u.km} km

Minimum: ${money(u.prices.minimum)}
Maximum: ${money(u.prices.maximum)}

Reply YES to send your request to drivers.`
    );
  }

  if (u.step === 'review') {
    if (text !== 'yes') {
      return reply(sock, jid, 'Reply YES to submit or CANCEL.');
    }

    const { data, error } = await supabase
      .from('bookings')
      .insert({
        phone: phoneFromJid(jid),
        customer_name: u.name,
        pickup: u.pickup,
        destination: u.destination,
        city: u.city,
        distance_km: u.km,
        min_price: u.prices.minimum,
        max_price: u.prices.maximum,
        status: 'open'
      })
      .select('id')
      .single();

    if (error || !data) {
      console.log('Supabase booking error:', error?.message);

      return reply(
        sock,
        jid,
        'Sorry, we could not submit your booking. Please try again.'
      );
    }

    u.bookingId = data.id;
    u.step = 'waiting_bids';
    u.bidStartedAt = Date.now();
    u.offers = [];

    await reply(
      sock,
      jid,
      `✅ REQUEST SUBMITTED!

Booking reference: ${data.id}

Your request is now available to drivers.

We will send you up to 7 driver offers here on WhatsApp.

Please wait up to ${BID_WINDOW_SECONDS} seconds.`
    );

    await notifyOwner(
      sock,
      `🚕 NEW BOOKING

Reference: ${data.id}
Name: ${u.name}
Phone: ${phoneFromJid(jid)}
Pickup: ${u.pickup}
Destination: ${u.destination}
Distance: ${u.km}km
Minimum: ${money(u.prices.minimum)}
Maximum: ${money(u.prices.maximum)}`
    );

    return;
  }

  if (u.step === 'waiting_bids') {
    return reply(
      sock,
      jid,
      'We are collecting driver offers. Please wait.'
    );
  }

  if (u.step === 'choose_driver') {
    const choice = Number(text);

    if (
      !Number.isInteger(choice) ||
      choice < 1 ||
      choice > u.offers.length
    ) {
      return reply(
        sock,
        jid,
        `Please select a number from 1 to ${u.offers.length}.`
      );
    }

    const selected = u.offers[choice - 1];

    const { data: booking, error: readError } = await supabase
      .from('bookings')
      .select('id,status')
      .eq('id', u.bookingId)
      .single();

    if (readError || !booking || booking.status !== 'bidding') {
      return reply(sock, jid, 'This booking is no longer available. Please contact support.');
    }

    const { data: updated, error } = await supabase
      .from('bookings')
      .update({
        status: 'driver_selected',
        selected_bid_id: selected.id,
        selected_driver_id: selected.driver_id
      })
      .eq('id', u.bookingId)
      .eq('status', 'bidding')
      .select('id');

    if (error || !updated?.length) {
      return reply(sock, jid, 'This booking could not be selected. Please contact support.');
    }

    const customerPhone = phoneFromJid(jid);

    try {
      await sock.sendMessage(
        String(selected.driver_phone).replace(/\D/g, '') + '@s.whatsapp.net',
        {
          text: `🚕 RIDE OFFER SELECTED

Booking: ${u.bookingId}

Customer: ${u.name}
Customer phone: ${customerPhone}

Pickup: ${u.pickup}
Destination: ${u.destination}
City: ${u.city}
Distance: ${u.km} km

Your bid: ${money(selected.price)}

Reply ACCEPT to accept or DECLINE to reject.`
        }
      );
    } catch (error) {
      console.log('Driver notification error:', error.message);
      return reply(sock, jid, 'Driver notification failed. Support has been alerted.');
    }

    u.step = 'awaiting_driver';

    await reply(
      sock,
      jid,
      `✅ You selected ${selected.driver_name} for ${money(selected.price)}.

The driver has received your ride details. We are waiting for confirmation.`
    );

    await notifyOwner(
      sock,
      `DRIVER SELECTED

Booking: ${u.bookingId}
Driver: ${selected.driver_name}
Price: ${money(selected.price)}
Customer: ${customerPhone}`
    );

    return;
  }

  if (u.step === 'awaiting_driver') {
    return reply(sock, jid, 'Your selected driver has received the request. We are waiting for confirmation.');
  }
}

// COLLECT THE FIRST 7 VALID DRIVER BIDS
async function checkDriverBids(sock) {
  for (const [jid, u] of users.entries()) {
    if (u.step !== 'waiting_bids') continue;

    const { data: bids, error } = await supabase
      .from('driver_bids')
      .select('id,booking_id,driver_id,driver_name,driver_phone,price,created_at')
      .eq('booking_id', u.bookingId)
      .eq('status', 'submitted')
      .order('created_at', { ascending: true })
      .limit(7);

    if (error) {
      console.log('Bid lookup error:', error.message);
      continue;
    }

    const validBids = (bids || []).filter(b =>
      b.driver_name &&
      b.driver_phone &&
      Number.isFinite(Number(b.price)) &&
      Number(b.price) > 0
    );

    const elapsed = Date.now() - u.bidStartedAt;

    if (
      validBids.length >= 7 ||
      (elapsed >= BID_WINDOW_SECONDS * 1000 && validBids.length > 0)
    ) {
      if (offeredBookings.has(u.bookingId)) continue;

      offeredBookings.add(u.bookingId);

      u.offers = validBids.slice(0, 7);
      u.step = 'choose_driver';

      await supabase
        .from('bookings')
        .update({ status: 'bidding' })
        .eq('id', u.bookingId)
        .eq('status', 'open');

      const list = u.offers.map((b, i) =>
        `${i + 1}. ${b.driver_name} — ${money(b.price)}`
      ).join('\n');

      await reply(
        sock,
        jid,
        `🚘 DRIVER OFFERS

${list}

Reply with the number of your preferred driver.

Your phone number and booking details will only be sent to the driver you select.`
      );
    }

    if (elapsed >= BID_WINDOW_SECONDS * 1000 && validBids.length === 0) {
      await supabase
        .from('bookings')
        .update({ status: 'no_bids' })
        .eq('id', u.bookingId)
        .eq('status', 'open');

      users.set(jid, { step: 'menu' });

      await reply(
        sock,
        jid,
        'Sorry, no drivers submitted an offer. Please try again later.'
      );
    }
  }
}

// WHATSAPP CONNECTION
async function startBot() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['My Chauffeur Zim', 'Chrome', '2.0.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('MY CHAUFFEUR ZIM PAIRING CODE:', code);
      } catch (error) {
        console.log('Pairing error:', error.message);
      }
    }, 5000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('✅ My Chauffeur Zim is ONLINE');

      setInterval(() => {
        checkDriverBids(sock).catch(error =>
          console.log('Bid polling error:', error.message)
        );
      }, 5000);
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('WhatsApp disconnected. Reconnect:', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(startBot, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (error) {
        console.log('Message error:', error.message);
      }
    }
  });
}

console.log('Starting My Chauffeur Zim...');

startBot().catch(error => {
  console.error('Startup error:', error);
  process.exit(1);
});
