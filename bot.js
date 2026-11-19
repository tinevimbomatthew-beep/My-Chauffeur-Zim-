
'use strict';

// ============================================
// MY CHAUFFEUR ZIM - PRODUCTION WHATSAPP BOT
// ============================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const http = require('http');

// ============================================
// CONFIGURATION
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const BOT_NUMBER = String(
  process.env.BOT_NUMBER || '263783264675'
).replace(/\D/g, '');

const PORT = Number(process.env.PORT || 3000);

const AUTH_FOLDER = '/app/auth_baileys';

const PER_KM = 1.50;

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

// ============================================
// GLOBAL STATE
// ============================================

let sock = null;
let isStarting = false;

let reconnectAttempts = 0;
let reconnectTimer = null;

let heartbeatInterval = null;
let bookingPollInterval = null;

let pairingCooldownUntil = 0;
let loggedOut = false;

const userState = {};

const logger = pino({ level: 'silent' });

// ============================================
// PHONE NUMBER VALIDATION
// ============================================

function validateBotNumber() {
  if (!/^263\d{9}$/.test(BOT_NUMBER)) {
    throw new Error(
      'Invalid BOT_NUMBER. Use Zimbabwe format: 263XXXXXXXXX'
    );
  }
}

// ============================================
// MAIN CONNECTION
// ============================================

async function start() {
  if (isStarting || sock || loggedOut) return;

  isStarting = true;

  let currentSock = null;

  try {
    validateBotNumber();

    console.log('====================================');
    console.log('🚕 MY CHAUFFEUR ZIM');
    console.log('Starting WhatsApp connection...');
    console.log('Attempt:', reconnectAttempts + 1);
    console.log('====================================');

    // Get latest compatible WhatsApp version
    let version;

    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      console.log('Baileys version:', version.join('.'));
    } catch (e) {
      console.log('Version lookup failed; using library default:', e.message);
    }

    // Load persistent authentication
    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_FOLDER);

    currentSock = makeWASocket({
      ...(version ? { version } : {}),

      auth: state,

      logger,

      printQRInTerminal: false,

      browser: [
        'My Chauffeur Zim',
        'Chrome',
        '1.0.0'
      ],

      syncFullHistory: false,

      markOnlineOnConnect: true,

      connectTimeoutMs: 60000,

      keepAliveIntervalMs: 15000,

      retryRequestDelayMs: 2000,

      maxMsgRetryCount: 5
    });

    sock = currentSock;

    // Save authentication credentials
    currentSock.ev.on('creds.update', saveCreds);

    // ========================================
    // CONNECTION EVENTS
    // ========================================

    let pairingStarted = false;

    currentSock.ev.on(
      'connection.update',
      async (update) => {

        if (currentSock !== sock) return;

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        console.log('WhatsApp connection:', connection || 'updating');

        // ------------------------------------
        // REQUEST PAIRING CODE ONLY ONCE
        // ------------------------------------

        if (
          !state.creds.registered &&
          !pairingStarted &&
          (connection === 'connecting' || qr)
        ) {

          pairingStarted = true;

          const remainingCooldown =
            pairingCooldownUntil - Date.now();

          if (remainingCooldown > 0) {
            console.log(
              'Pairing cooldown active. Waiting:',
              Math.ceil(remainingCooldown / 1000),
              'seconds'
            );

            return;
          }

          try {
            // Give WhatsApp time to establish the connection
            await new Promise(resolve =>
              setTimeout(resolve, 4000)
            );

            if (
              currentSock !== sock ||
              state.creds.registered
            ) {
              return;
            }

            console.log('Requesting WhatsApp pairing code...');

            const code =
              await currentSock.requestPairingCode(BOT_NUMBER);

            console.log('');
            console.log('====================================');
            console.log('🚕 MY CHAUFFEUR ZIM');
            console.log('WHATSAPP PAIRING CODE:');
            console.log('');
            console.log(code);
            console.log('');
            console.log('Open WhatsApp Business:');
            console.log('Settings > Linked Devices');
            console.log('Link with phone number instead');
            console.log('====================================');
            console.log('');

          } catch (e) {
            console.log('Pairing error:', e.message);
            console.log('No automatic pairing-code loop will run.');
          }
        }

        // ------------------------------------
        // SUCCESSFUL CONNECTION
        // ------------------------------------

        if (connection === 'open') {

          console.log('');
          console.log('====================================');
          console.log('✅ WHATSAPP CONNECTED SUCCESSFULLY');
          console.log('🚕 MY CHAUFFEUR ZIM IS ONLINE');
          console.log('====================================');
          console.log('');

          reconnectAttempts = 0;

          startHeartbeat();
        }

        // ------------------------------------
        // CONNECTION CLOSED
        // ------------------------------------

        if (connection === 'close') {

          stopHeartbeat();

          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          const reason =
            lastDisconnect?.error?.message || 'Unknown';

          console.log('WhatsApp disconnected.');
          console.log('Status:', statusCode);
          console.log('Reason:', reason);

          if (currentSock === sock) {
            sock = null;
          }

          // Logged out: do not keep requesting codes
          if (statusCode === DisconnectReason.loggedOut) {

            loggedOut = true;

            console.log('');
            console.log('❌ WHATSAPP SESSION LOGGED OUT');
            console.log('A fresh authentication is required.');
            console.log('Check your Railway auth_baileys volume.');
            console.log('');

            return;
          }

          // Rate limit protection
          if (statusCode === 405) {

            console.log(
              '⚠️ WhatsApp rate limit detected. Waiting 10 minutes.'
            );

            pairingCooldownUntil =
              Date.now() + (10 * 60 * 1000);

            scheduleRestart(10 * 60 * 1000);

            return;
          }

          // Normal reconnection
          reconnectAttempts++;

          const delay = Math.min(
            5000 * reconnectAttempts,
            60000
          );

          console.log(
            'Reconnecting in',
            delay / 1000,
            'seconds'
          );

          scheduleRestart(delay);
        }
      }
    );

    // ========================================
    // INCOMING WHATSAPP MESSAGES
    // ========================================

    currentSock.ev.on(
      'messages.upsert',
      async ({ messages }) => {

        if (currentSock !== sock) return;

        for (const message of messages) {

          try {

            if (!message.message) continue;
            if (message.key.fromMe) continue;

            const jid = message.key.remoteJid;

            if (!jid || jid.endsWith('@g.us')) continue;

            const from = jid.endsWith('@s.whatsapp.net')
              ? jid.replace('@s.whatsapp.net', '')
              : jid;

            const content = message.message;

            const text =
              content.conversation ||
              content.extendedTextMessage?.text ||
              content.imageMessage?.caption ||
              content.videoMessage?.caption ||
              content.documentMessage?.caption ||
              '';

            if (!text.trim()) continue;

            await handleMessage(from, text.trim());

          } catch (e) {
            console.log('Message error:', e.message);
          }
        }
      }
    );

    isStarting = false;

  } catch (e) {

    console.log('START ERROR:', e.message);

    if (currentSock && sock === currentSock) {
      sock = null;
    }

    isStarting = false;

    scheduleRestart(10000);
  }
}

// ============================================
// RECONNECTION MANAGER
// ============================================

function scheduleRestart(delay) {

  if (loggedOut || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {

    reconnectTimer = null;

    safeRestart();

  }, delay);
}

function safeRestart() {

  if (loggedOut || isStarting || sock) return;

  console.log('Restarting WhatsApp connection...');

  start();
}

// ============================================
// HEARTBEAT
// ============================================

function startHeartbeat() {

  stopHeartbeat();

  heartbeatInterval = setInterval(() => {

    console.log(
      '💓 My Chauffeur Zim alive:',
      new Date().toISOString()
    );

    if (sock) {
      sock.sendPresenceUpdate('available')
        .catch(() => {});
    }

  }, 30000);

  bookingPollInterval = setInterval(
    checkWebsiteBookings,
    15000
  );

  // Initial website booking check
  checkWebsiteBookings();
}

function stopHeartbeat() {

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  if (bookingPollInterval) {
    clearInterval(bookingPollInterval);
  }

  heartbeatInterval = null;
  bookingPollInterval = null;
}

// ============================================
// SEND WHATSAPP MESSAGE
// ============================================

async function send(to, text) {

  try {

    if (!sock) return false;

    const jid = String(to).includes('@')
      ? String(to)
      : String(to).replace(/\D/g, '') + '@s.whatsapp.net';

    await sock.sendMessage(jid, { text });

    return true;

  } catch (e) {

    console.log('Message sending error:', e.message);

    return false;
  }
}

// ============================================
// CUSTOMER BOOKING SYSTEM
// ============================================

async function handleMessage(from, text) {

  try {

    const lower = text.toLowerCase();

    const st = userState[from] || {
      step: 'start'
    };

    // START MENU
    if (['hi', 'hello', 'menu', 'start', 'hey'].includes(lower)) {

      st.step = 'pickup';

      userState[from] = st;

      await send(
        from,
        `🚕 *MY CHAUFFEUR ZIM*

Welcome! Let's book your ride.

💵 Price: $1.50 per km

Where is your *pickup*?

Example: Bulawayo CBD`
      );

      return;
    }

    // PICKUP
    if (st.step === 'pickup') {

      st.pickup = text;

      st.step = 'destination';

      userState[from] = st;

      await send(
        from,
        `📍 Pickup: ${text}

Where is your *destination*?`
      );

      return;
    }

    // DESTINATION
    if (st.step === 'destination') {

      st.destination = text;

      st.step = 'km';

      userState[from] = st;

      await send(
        from,
        `📍 Destination: ${text}

How many kilometres is the journey?

Send a number, for example: 10`
      );

      return;
    }

    // DISTANCE
    if (st.step === 'km') {

      const km = Number(text);

      if (!Number.isFinite(km) || km <= 0) {

        await send(
          from,
          'Please enter a valid distance greater than zero. Example: 10'
        );

        return;
      }

      const total = (km * PER_KM).toFixed(2);

      st.km = km;
      st.total = total;
      st.step = 'confirm';

      userState[from] = st;

      await send(
        from,
        `📋 *CONFIRM YOUR BOOKING*

📍 From: ${st.pickup}

🏁 To: ${st.destination}

📏 Distance: ${km} km

💵 Total: $${total}

Reply *YES* to confirm.

Reply *NO* to cancel.`
      );

      return;
    }

    // CONFIRM BOOKING
    if (st.step === 'confirm' && lower === 'yes') {

      if (!supabase) {

        await send(
          from,
          'Our booking system is temporarily unavailable. Please try again shortly.'
        );

        return;
      }

      const { data, error } = await supabase
        .from('bookings')
        .insert([{

          customer_name: from,
          phone: from,

          pickup: st.pickup,
          destination: st.destination,

          city: 'Bulawayo',

          distance_km: st.km,
          price: st.total,

          status: 'pending',
          source: 'whatsapp',
          whatsapp_sent: true

        }])
        .select()
        .single();

      if (error) {

        console.log('Supabase booking error:', error.message);

        await send(
          from,
          'We could not save your booking. Please try again.'
        );

        return;
      }

      delete userState[from];

      await send(
        from,
        `✅ *BOOKING CONFIRMED*

Thank you for choosing My Chauffeur Zim!

Booking ID: ${data.id}

📍 ${st.pickup} → ${st.destination}

📏 ${st.km} km

💵 $${st.total}

A driver will contact you shortly.

Thank you! 🚕`
      );

      // Notify administrator
      await send(
        BOT_NUMBER,
        `🚕 *NEW WHATSAPP BOOKING*

Booking ID: ${data.id}

Pickup: ${st.pickup}

Destination: ${st.destination}

Distance: ${st.km} km

Price: $${st.total}

Customer: ${from}

Status: Pending`
      );

      return;
    }

    // CANCEL BOOKING
    if (st.step === 'confirm' && lower === 'no') {

      delete userState[from];

      await send(
        from,
        '❌ Booking cancelled.\n\nSend HI whenever you want to book another ride.'
      );

      return;
    }

    // DEFAULT RESPONSE
    await send(
      from,
      'Welcome to My Chauffeur Zim! 🚕\n\nSend *HI* to start booking your ride.'
    );

  } catch (e) {

    console.log('Booking handler error:', e.message);
  }
}

// ============================================
// WEBSITE BOOKING NOTIFICATIONS
// ============================================

async function checkWebsiteBookings() {

  try {

    if (!sock || !supabase) return;

    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('source', 'website')
      .eq('whatsapp_sent', false)
      .eq('status', 'pending');

    if (error) {

      console.log('Website booking query error:', error.message);

      return;
    }

    if (!data || data.length === 0) return;

    for (const booking of data) {

      const adminMessage =
        `🌐 *NEW WEBSITE BOOKING*

Booking ID: ${booking.id}

Customer: ${booking.customer_name}

Phone: ${booking.phone}

Pickup: ${booking.pickup}

Destination: ${booking.destination}

City: ${booking.city}

Distance: ${booking.distance_km} km

Price: $${booking.price}

Status: Pending`;

      const customerMessage =
        `✅ *MY CHAUFFEUR ZIM*

Your booking has been received!

Booking ID: ${booking.id}

${booking.pickup} → ${booking.destination}

Distance: ${booking.distance_km} km

Total: $${booking.price}

A driver will contact you shortly.

Thank you for choosing us! 🚕`;

      const adminSent = await send(
        BOT_NUMBER,
        adminMessage
      );

      const customerSent = await send(
        booking.phone,
        customerMessage
      );

      if (adminSent && customerSent) {

        const { error: updateError } = await supabase
          .from('bookings')
          .update({ whatsapp_sent: true })
          .eq('id', booking.id);

        if (updateError) {
          console.log(
            'Booking notification update error:',
            updateError.message
          );
        } else {
          console.log(
            'Website booking notifications sent:',
            booking.id
          );
        }

      } else {

        console.log(
          'Website notification incomplete:',
          booking.id
        );
      }
    }

  } catch (e) {

    console.log('Website booking checker error:', e.message);
  }
}

// ============================================
// RAILWAY HEALTH CHECK SERVER
// ============================================

const server = http.createServer((req, res) => {

  res.writeHead(200, {
    'Content-Type': 'text/plain'
  });

  res.end(
    'My Chauffeur Zim Bot Alive - ' +
    new Date().toISOString()
  );
});

server.listen(PORT, '0.0.0.0', () => {

  console.log('Health server listening on port:', PORT);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

function shutdown(signal) {

  console.log(signal, 'received. Shutting down safely.');

  stopHeartbeat();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  try {
    if (sock) {
      sock.end(new Error('Application shutting down'));
    }
  } catch (e) {
    console.log('Socket shutdown:', e.message);
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000)
    .unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {

  console.error('UNCAUGHT EXCEPTION:', error);

  // Let Railway restart an unstable process
  process.exit(1);
});

process.on('unhandledRejection', (error) => {

  console.error('UNHANDLED REJECTION:', error);
});

// ============================================
// START APPLICATION
// ============================================

console.log('');
console.log('🚕 Starting My Chauffeur Zim...');
console.log('WhatsApp number:', BOT_NUMBER);
console.log('Supabase:', supabase ? 'Configured' : 'Missing');
console.log('');

start();

// Watchdog
setInterval(() => {

  if (!sock && !isStarting && !loggedOut && !reconnectTimer) {

    console.log('Watchdog: restarting missing socket');

    safeRestart();
  }

}, 60000);
