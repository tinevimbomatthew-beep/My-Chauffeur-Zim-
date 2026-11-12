require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');

// --- Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// --- WhatsApp Client - Render / Chrome Fix ---
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

// --- QR Code ---
client.on('qr', (qr) => {
  console.log('SCAN THIS QR CODE:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ My Chauffeur Zim Bot is READY!');
});

client.on('auth_failure', (msg) => {
  console.log('❌ Auth failure:', msg);
});

client.on('disconnected', (reason) => {
  console.log('❌ Disconnected:', reason);
});

// --- Simple booking memory ---
const userState = {};

// --- Messages ---
client.on('message', async (msg) => {
  try {
    const from = msg.from;
    const text = msg.body.trim().toLowerCase();

    // Ignore groups and status
    if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;

    // --- START / MENU ---
    if (['hi', 'hello', 'hey', 'menu', '1'].includes(text) || text === 'start') {
      userState[from] = { step: 'menu' };
      return msg.reply(
        `🚖 *Welcome to My Chauffeur Zim!*\n\n` +
        `How can we help you today?\n\n` +
        `1️⃣ Book a Ride\n` +
        `2️⃣ Our Prices\n` +
        `3️⃣ Talk to Support\n\n` +
        `Reply with 1, 2 or 3`
      );
    }

    // --- BOOK A RIDE ---
    if (text === '1' && userState[from]?.step === 'menu') {
      userState[from] = { step: 'pickup' };
      return msg.reply(`📍 Where should we pick you up from?\n\nSend your pickup location (e.g. Avondale, Harare)`);
    }

    if (userState[from]?.step === 'pickup') {
      userState[from].pickup = msg.body.trim();
      userState[from].step = 'dropoff';
      return msg.reply(`📍 Pickup saved: *${userState[from].pickup}*\n\nWhere are you going to? Send your drop-off location.`);
    }

    if (userState[from]?.step === 'dropoff') {
      userState[from].dropoff = msg.body.trim();
      userState[from].step = 'date';
      return msg.reply(`📍 Drop-off saved: *${userState[from].dropoff}*\n\nWhen do you need the ride? (e.g. Today 2pm, Tomorrow 9am)`);
    }

    if (userState[from]?.step === 'date') {
      userState[from].date = msg.body.trim();
      userState[from].step = 'name';
      return msg.reply(`🗓️ Date/Time saved: *${userState[from].date}*\n\nWhat is your full name?`);
    }

    if (userState[from]?.step === 'name') {
      userState[from].name = msg.body.trim();

      const booking = {
        phone: from.replace('@c.us', ''),
        name: userState[from].name,
        pickup: userState[from].pickup,
        dropoff: userState[from].dropoff,
        ride_date: userState[from].date,
        status: 'pending'
      };

      // Save to Supabase
      const { error } = await supabase.from('bookings').insert([booking]);

      if (error) {
        console.log('Supabase error:', error.message);
      }

      userState[from] = { step: 'done' };

      return msg.reply(
        `✅ *Booking Received!*\n\n` +
        `👤 Name: ${booking.name}\n` +
        `📍 From: ${booking.pickup}\n` +
        `📍 To: ${booking.dropoff}\n` +
        `🗓️ When: ${booking.ride_date}\n\n` +
        `A driver will contact you shortly to confirm price.\n\n` +
        `Type *hi* to book another ride.`
      );
    }

    // --- PRICES ---
    if (text === '2') {
      return msg.reply(
        `💰 *My Chauffeur Zim Prices*\n\n` +
        `• Within Harare CBD: From $10\n` +
        `• Harare Suburbs: From $15\n` +
        `• Airport Transfer: From $25\n` +
        `• Full Day Hire: From $80\n\n` +
        `Final price depends on distance.\n\n` +
        `Type *1* to Book a Ride`
      );
    }

    // --- SUPPORT ---
    if (text === '3') {
      return msg.reply(
        `📞 *Support*\n\n` +
        `Call / WhatsApp us on: +263 77 XXX XXXX\n` +
        `We reply within 5-10 minutes.\n\n` +
        `Type *hi* to go back to menu`
      );
    }

    // --- FALLBACK ---
    if (!userState[from] || userState[from].step === 'done') {
      return msg.reply(`Hi! 👋 Type *hi* to see the menu.`);
    }

  } catch (err) {
    console.log('Message error:', err.message);
  }
});

client.initialize();
