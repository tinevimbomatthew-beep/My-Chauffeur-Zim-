const fs = require('fs');
global.WebSocket = require('ws');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const PHONE = '263783264675';

async function start() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth');
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ['Chauffeur', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);

  let timer = null;
  async function getCode() {
    if (sock.authState.creds.registered) return;
    try {
      const code = await sock.requestPairingCode(PHONE);
      console.log('YOUR_CODE_IS:' + code);
    } catch (e) { console.log('FAIL:' + e.message); }
  }

  sock.ev.on('connection.update', async (u) => {
    console.log('STATUS:' + u.connection);
    if (u.connection === 'connecting') {
      if (!sock.authState.creds.registered) {
        getCode();
        timer = setInterval(getCode, 60000);
      }
    }
    if (u.connection === 'open') {
      console.log('BOT IS READY');
      if (timer) clearInterval(timer);
    }
    if (u.connection === 'close') {
      if (timer) clearInterval(timer);
      const code = u.lastDisconnect?.error?.output?.statusCode;
      console.log('CLOSED:' + code);
      try { fs.rmSync('/tmp/auth', { recursive: true, force: true }); } catch {}
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;
    const text = (m.message.conversation || '').trim().toLowerCase();
    if (text === 'hi' || text === 'hello') {
      await sock.sendMessage(m.key.remoteJid, { text: 'Hi! My Chauffeur Zim is working 🚕 Type 1 to Book' });
    }
  });
}

start();
