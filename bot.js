global.WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');

// --- SUPABASE ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// --- WHATSAPP CLIENT ---
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('Scan this QR code:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('My Chauffeur Zim Bot is ready!');
});

const userState = {};

const MAIN_MENU = `👋 *Welcome to My Chauffeur Zim!*\n\n` +
  `How can we help you today?\n\n` +
  `Type *1* to Book a Ride 🚖\n` +
  `Type *2* for Prices 💰\n` +
  `Type *3* for Support 📞`;

client.on('message', async (msg) => {
  try {
    const from = msg.from;
    const text = msg.body.trim().toLowerCase();

    if (text === 'hi' || text === 'hello' || text === 'menu') {
      userState[from] = { step: 'menu' };
      return msg.reply(MAIN_MENU);
    }

    if (!userState[from]) {
      userState[from] = { step: 'menu' };
      return msg.reply(MAIN_MENU);
    }

    if (text === '1' && userState[from].step === 'menu') {
      userState[from] = { step: 'pickup', booking: {} };
      return msg.reply(`🚖 *Book a Ride*\n\nWhere should we pick you up from?`);
    }

    if (userState[from].step === 'pickup') {
      userState[from].booking.pickup = msg.body;
      userState[from].step = 'dropoff';
      return msg.reply(`Great. Where are you going to?`);
    }

    if (userState[from].step === 'dropoff') {
      userState[from].booking.dropoff = msg.body;
      userState[from].step = 'datetime';
      return msg.reply(`When do you need the ride? (e.g. Today 2pm / Tomorrow 9am)`);
    }

    if (userState[from].step === 'datetime') {
      userState[from].booking.datetime = msg.body;
      userState[from].step = 'name';
      return msg.reply(`What is your name?`);
    }

    if (userState[from].step === 'name') {
      userState[from].booking.name = msg.body;
      userState[from].booking.phone = from;
      userState[from].booking.status = 'pending';

      const { error } = await supabase
        .from('bookings')
        .insert([userState[from].booking]);

      if (error) {
        console.log('Supabase error:', error.message);
        userState[from].step = 'done';
        return msg.reply(`Thanks ${userState[from].booking.name}! We got your request. We will confirm shortly.\n\nType *hi* to go back to menu`);
      }

      userState[from].step = 'done';
      return msg.reply(
        `✅ *Booking Received!*\n\n` +
        `Name: ${userState[from].booking.name}\n` +
        `From: ${userState[from].booking.pickup}\n` +
        `To: ${userState[from].booking.dropoff}\n` +
        `When: ${userState[from].booking.datetime}\n\n` +
        `A driver will be assigned soon.\n\n` +
        `Type *hi* to go back to menu`
      );
    }

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

    if (text === '3') {
      return msg.reply(
        `📞 *Support*\n\n` +
        `Call / WhatsApp us on: +263 77 XXX XXXX\n` +
        `We reply within 15-20 seconds.\n\n` +
        `Type *hi* to go back to menu`
      );
    }

    if (!userState[from] || userState[from].step === 'done') {
      return msg.reply(`Hi! 👋 Type *hi* to see the menu.`);
    }

  } catch (err) {
    console.log('Message error:', err.message);
  }
});

client.initialize();
