const express = require('express');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.json());

// ── Firebase Admin Setup ──────────────────────────────────
// We use environment variables for security
const firebaseConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID,
};

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').split('\\n').join('\n'),
  }),
});

const db = getFirestore();

// ── Config from environment variables ────────────────────
const PAGE_TOKEN    = process.env.PAGE_TOKEN;
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN || 'liveorder_verify_2024';
const PAGE_ID       = process.env.PAGE_ID;

// ── Helper: Get price for code ────────────────────────────
async function getPriceForCode(code) {
  const snap = await db.collection('price_ranges').get();
  for (const doc of snap.docs) {
    const r = doc.data();
    if (code >= r.from && code <= r.to) return r.price;
  }
  return null;
}

// ── Helper: Get owner of code ─────────────────────────────
async function getOwner(code) {
  const snap = await db.collection('orders')
    .where('code', '==', code)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data().userName;
}

// ── Helper: Get all orders for user ──────────────────────
async function getUserOrders(userName) {
  const snap = await db.collection('orders')
    .where('userName', '==', userName)
    .orderBy('createdAt', 'asc')
    .get();
  return snap.docs.map(d => d.data());
}

// ── Helper: Send Messenger Message ────────────────────────
async function sendMessengerMessage(psid, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/me/messages`,
      {
        recipient: { id: psid },
        message: { text: message },
        messaging_type: 'RESPONSE'
      },
      {
        params: { access_token: PAGE_TOKEN }
      }
    );
    console.log(`✅ Messenger sent to ${psid}`);
  } catch (e) {
    console.error('❌ Messenger error:', e.response?.data || e.message);
  }
}

// ── Helper: Reply on Comment ──────────────────────────────
async function replyOnComment(commentId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${commentId}/comments`,
      { message },
      { params: { access_token: PAGE_TOKEN } }
    );
    console.log(`✅ Comment reply sent`);
  } catch (e) {
    console.error('❌ Comment reply error:', e.response?.data || e.message);
  }
}

// ── Helper: Build order message ───────────────────────────
function buildOrderMessage(userName, orders) {
  const lines = orders.map(o => {
    const qty   = o.qty   || 1;
    const price = o.price || 0;
    return `📦 កូដ #${o.code} × ${qty} = $${(qty * price).toFixed(2)}`;
  }).join('\n');
  const total = orders.reduce((s, o) => s + ((o.qty||1) * (o.price||0)), 0);
  return `✅ បានទទួលការបញ្ជាទិញ!\n\n👤 ${userName}\n━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━\n💵 សរុបទាំងអស់: $${total.toFixed(2)}\n\n🙏 អរគុណសម្រាប់ការបញ្ជាទិញ!`;
}

// ── Extract code from message ─────────────────────────────
function extractCode(text) {
  const match = text.trim().match(/^\s*(\d+)\s*$/);
  return match ? parseInt(match[1]) : null;
}

// ── Process Comment ───────────────────────────────────────
async function processComment(senderPsid, senderName, message, commentId) {
  console.log(`💬 ${senderName} (${senderPsid}): ${message}`);

  const code = extractCode(message);
  if (code === null) return; // not a code

  const price = await getPriceForCode(code);
  if (!price) return; // not in range — silent reject

  const owner = await getOwner(code);
  if (owner) {
    // Code taken — silent reject, no message
    console.log(`❌ Code ${code} already taken by ${owner}`);
    await db.collection('rejected_orders').add({
      attemptedBy: senderName,
      code,
      ownedBy: owner,
      reason: 'CODE_TAKEN',
      createdAt: new Date()
    });
    return;
  }

  // ✅ Save order
  const userName = senderName || 'User_' + senderPsid.slice(-6);
  await db.collection('orders').add({
    userName,
    fbUserId: senderPsid,
    code,
    price,
    qty: 1,
    source: 'facebook_live',
    createdAt: new Date()
  });
  console.log(`✅ Order saved: ${userName} → Code #${code}`);

  // Get all orders for this user for message
  const allOrders = await getUserOrders(userName);
  const msg = buildOrderMessage(userName, allOrders);

  // Send Messenger message if we have PSID
  if (senderPsid && senderPsid !== 'unknown') {
    await sendMessengerMessage(senderPsid, msg);
  }

  // Also reply on comment
  if (commentId) {
    await replyOnComment(commentId, msg);
  }
}

// ── Webhook Verification ──────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Webhook Events ────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const body = req.body;
  res.sendStatus(200); // Always respond 200 first

  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      // Handle messaging events (Messenger)
      for (const event of entry.messaging || []) {
        if (event.message && !event.message.is_echo) {
          const psid    = event.sender.id;
          const message = event.message.text || '';
          console.log(`📨 Messenger from ${psid}: ${message}`);
          // Can process messenger messages here if needed
        }
      }

      // Handle feed changes (comments on posts/live)
      for (const change of entry.changes || []) {
        if (change.field === 'feed' || change.field === 'live_videos') {
          const val = change.value;

          if (val.item === 'comment' && val.verb === 'add') {
            const commentId  = val.comment_id;
            const message    = val.message || '';
            const senderName = val.from?.name || 'User_' + (val.from?.id || 'unknown').slice(-6);
            const senderPsid = val.from?.id || 'unknown';

            await processComment(senderPsid, senderName, message, commentId);
          }
        }
      }
    }
  }
});

// ── Health Check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'LiveOrder Server running! 🔴',
    time: new Date().toISOString()
  });
});

// ── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LiveOrder Server running on port ${PORT}`);
});
