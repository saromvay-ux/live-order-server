const express = require('express');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = express();
app.use(express.json());

// ── Firebase Admin Setup ──────────────────────────────────
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').split('\\n').join('\n'),
  }),
});

const db = getFirestore();

// ── Deduplication ─────────────────────────────────────────
const seenMessageIds = new Set(); // prevent double processing

// ── Config ────────────────────────────────────────────────
const PAGE_TOKEN   = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'liveorder_verify_2024';

// ── Helper: Get Live Mode Status ─────────────────────────
async function getLiveMode() {
  try {
    const snap = await db.collection('settings').doc('live_mode').get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data.active) return null;
    return data; // { active, liveVideoId, pageId }
  } catch(e) {
    return null;
  }
}

// ── Helper: Get price range for code ─────────────────────
async function getPriceRangeForCode(code) {
  const snap = await db.collection('price_ranges').get();
  for (const doc of snap.docs) {
    const r = doc.data();
    if (code >= r.from && code <= r.to) return r.price;
  }
  return null;
}

// ── Helper: Get stock code ────────────────────────────────
async function getStockCode(code) {
  const snap = await db.collection('stock_codes')
    .where('code', '==', code)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// ── Helper: Get owner of price range code ─────────────────
async function getPriceRangeOwner(code) {
  const snap = await db.collection('orders')
    .where('code', '==', code)
    .where('type', '==', 'price_range')
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
      { recipient: { id: psid }, message: { text: message }, messaging_type: 'RESPONSE' },
      { params: { access_token: PAGE_TOKEN } }
    );
    console.log(`✅ Messenger sent to ${psid}`);
    return true;
  } catch(e) {
    console.error('❌ Messenger error:', e.response?.data?.error?.message || e.message);
    return false;
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
  } catch(e) {
    console.error('❌ Comment reply error:', e.response?.data?.error?.message || e.message);
  }
}

// ── Helper: Send Private Reply to Comment ────────────────
// Falls back to comment reply for live video comments
async function sendPrivateReply(commentId, message) {
  // Private reply not supported for live video comments
  // Fall back to comment reply directly
  await replyOnComment(commentId, message);
}

// ── Helper: Build order message ───────────────────────────
function buildOrderMessage(userName, orders) {
  const lines = orders.map(o => {
    const qty   = o.qty   || 1;
    const price = o.price || 0;
    return `📦 កូដ #${o.code} × ${qty} = $${(qty * price).toFixed(2)}`;
  }).join('\n');
  const total = orders.reduce((s,o) => s + ((o.qty||1) * (o.price||0)), 0);
  return `✅ បានទទួលការបញ្ជាទិញ!\n\n👤 ${userName}\n━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━\n💵 សរុបទាំងអស់: $${total.toFixed(2)}\n\n🙏 អរគុណសម្រាប់ការបញ្ជាទិញ!`;
}

// ── Helper: Parse comment ─────────────────────────────────
// Valid: "34" → {code:34, qty:1}
// Valid: "34=2" → {code:34, qty:2}
// Invalid: "34x2", "34*2", "34-2" → null
function parseComment(text) {
  const trimmed = text.trim();

  // Format: code=qty (ONLY = separator allowed)
  const matchEq = trimmed.match(/^(\d+)=(\d+)$/);
  if (matchEq) {
    const code = parseInt(matchEq[1]);
    const qty  = parseInt(matchEq[2]);
    if (qty < 1) return null;
    return { code, qty };
  }

  // Format: code only (single number)
  const matchNum = trimmed.match(/^(\d+)$/);
  if (matchNum) {
    return { code: parseInt(matchNum[1]), qty: 1 };
  }

  // Everything else → reject
  return null;
}

// ── Process Comment ───────────────────────────────────────
async function processComment(senderPsid, senderName, message, commentId) {
  console.log(`💬 ${senderName} (${senderPsid}): ${message}`);

  const parsed = parseComment(message);
  if (!parsed) return; // invalid format — silent ignore

  const { code, qty } = parsed;
  const userName = senderName || 'User_' + senderPsid.slice(-6);

  // ── Check Stock Code first ────────────────────────────
  const stockCode = await getStockCode(code);
  if (stockCode) {
    // Stock code found — handle stock logic
    if (stockCode.remainingQty <= 0) {
      console.log(`❌ Code #${code} is SOLD OUT`);
      // Silent reject — no message
      await db.collection('rejected_orders').add({
        attemptedBy: userName,
        code, qty,
        reason: 'SOLD_OUT',
        createdAt: new Date()
      });
      return;
    }

    if (qty > stockCode.remainingQty) {
      console.log(`❌ Not enough stock for code #${code}. Requested: ${qty}, Remaining: ${stockCode.remainingQty}`);
      // Silent reject — no message
      await db.collection('rejected_orders').add({
        attemptedBy: userName,
        code, qty,
        reason: 'INSUFFICIENT_STOCK',
        remainingQty: stockCode.remainingQty,
        createdAt: new Date()
      });
      return;
    }

    // ✅ Deduct stock atomically
    await db.collection('stock_codes').doc(stockCode.id).update({
      remainingQty: FieldValue.increment(-qty),
      soldQty: FieldValue.increment(qty)
    });

    // ✅ Save order
    await db.collection('orders').add({
      userName,
      fbUserId: senderPsid,
      code,
      price: stockCode.price,
      qty,
      type: 'stock_code',
      source: 'facebook_live',
      createdAt: new Date()
    });
    console.log(`✅ Stock order saved: ${userName} → Code #${code} × ${qty} @ $${stockCode.price}`);

    // Build message
    const allOrders = await getUserOrders(userName);
    const msg = buildOrderMessage(userName, allOrders);

    // Send Messenger or comment reply
    if (senderPsid && senderPsid !== 'unknown') {
      const sent = await sendMessengerMessage(senderPsid, msg);
      if (!sent && commentId) {
        // New customer - send via Private Reply (no need to message page first!)
        await sendPrivateReply(commentId, msg);
      }
    } else if (commentId) {
      await replyOnComment(commentId, msg);
    }
    return;
  }

  // ── Check Price Range ─────────────────────────────────
  // Price range only allows qty=1 (one owner per code)
  const price = await getPriceRangeForCode(code);
  if (!price) return; // code not in any range — silent ignore

  // Price range: reject if qty > 1
  if (qty > 1) {
    console.log(`❌ Price range code #${code} only allows qty=1`);
    return; // silent reject
  }

  const owner = await getPriceRangeOwner(code);
  if (owner) {
    console.log(`❌ Code #${code} already taken by ${owner}`);
    await db.collection('rejected_orders').add({
      attemptedBy: userName,
      code,
      ownedBy: owner,
      reason: 'CODE_TAKEN',
      createdAt: new Date()
    });
    return;
  }

  // ✅ Save price range order
  await db.collection('orders').add({
    userName,
    fbUserId: senderPsid,
    code,
    price,
    qty: 1,
    type: 'price_range',
    source: 'facebook_live',
    createdAt: new Date()
  });
  console.log(`✅ Price range order saved: ${userName} → Code #${code} @ $${price}`);

  // Build message & send
  const allOrders = await getUserOrders(userName);
  const msg = buildOrderMessage(userName, allOrders);

  if (senderPsid && senderPsid !== 'unknown') {
    const sent = await sendMessengerMessage(senderPsid, msg);
    if (!sent && commentId) {
      // New customer - send via Private Reply (no need to message page first!)
      await sendPrivateReply(commentId, msg);
    }
  } else if (commentId) {
    // No PSID - send via Private Reply
    await sendPrivateReply(commentId, msg);
  }
}

// ── Handle Incoming Messenger Message ────────────────────
// When customer messages page → find their orders by fbUserId → send summary
async function handleIncomingMessage(psid, message) {
  try {
    // Check last time we sent summary to this customer
    const sentRef  = db.collection('message_sent_log').doc(psid);
    const sentSnap = await sentRef.get();
    const lastSentCount = sentSnap.exists ? (sentSnap.data().orderCount || 0) : -1;

    // Find all orders by this customer
    const snap = await db.collection('orders')
      .where('fbUserId', '==', psid)
      .orderBy('createdAt', 'asc')
      .get();

    if (snap.empty) {
      // No orders — send welcome only if never contacted before
      if (lastSentCount === -1) {
        console.log('No orders for ' + psid + ' — sending welcome');
        await sendMessengerMessage(psid,
          'សួស្តី! 👋\nអរគុណដែលបានទំនាក់ទំនងមកកាន់យើង!\n\nប្រសិនបើអ្នកចង់បញ្ជាទិញ សូមរង់ចាំការ Live លក់របស់យើង! 🛍️'
        );
        await sentRef.set({ lastSentAt: new Date(), orderCount: 0 });
      } else {
        console.log('No orders for ' + psid + ' — skip (already welcomed)');
      }
      return;
    }

    const orders = snap.docs.map(d => d.data());

    // Only send if there are NEW orders since last send
    if (orders.length <= lastSentCount) {
      console.log('No new orders for ' + psid + ' (' + orders.length + ' orders, last sent: ' + lastSentCount + ') — skip');
      return;
    }

    // New orders exist — send updated summary
    const userName = orders[0].userName || 'បងប្អូន';
    const msg      = buildOrderMessage(userName, orders);
    await sendMessengerMessage(psid, msg);

    // Save last sent log
    await sentRef.set({ lastSentAt: new Date(), orderCount: orders.length });
    console.log('Summary sent to ' + psid + ' (' + orders.length + ' orders)');

  } catch(e) {
    console.error('handleIncomingMessage error:', e.message);
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
  res.sendStatus(200);

  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (event.message && !event.message.is_echo) {
          const psid    = event.sender.id;
          const message = (event.message.text || '').trim();
          const mid     = event.message.mid || '';

          // Skip if already processed this message
          if (mid && seenMessageIds.has(mid)) {
            console.log(`⏭️ Duplicate message skipped: ${mid}`);
            continue;
          }
          if (mid) seenMessageIds.add(mid);

          console.log(`📨 Messenger from ${psid}: ${message}`);
          await handleIncomingMessage(psid, message);
        }
      }
      for (const change of entry.changes || []) {
        if (change.field === 'feed' || change.field === 'live_videos') {
          const val = change.value;
          if (val.item === 'comment' && val.verb === 'add') {
            const commentId  = val.comment_id;
            const message    = val.message || '';
            const senderName = val.from?.name || 'User_' + (val.from?.id || 'unknown').slice(-6);
            const senderPsid = val.from?.id || 'unknown';

            // Check Live Mode — only process comments from active live video
            const liveMode = await getLiveMode();
            if (!liveMode) {
              console.log(`⏸️ Live Mode OFF — ignoring comment from ${senderName}`);
              return;
            }

            // Check if comment is from the active live video
            const postId   = val.post_id   || '';
            const videoId  = val.video_id  || '';
            const parentId = val.parent_id || '';
            const liveId   = liveMode.liveVideoId;

            console.log(`🔍 Checking: postId=${postId} videoId=${videoId} parentId=${parentId} commentId=${commentId} liveId=${liveId}`);

            // Match if any ID contains the live video ID
            const isFromLive = 
              postId.includes(liveId) ||
              videoId.includes(liveId) ||
              commentId.includes(liveId) ||
              parentId.includes(liveId) ||
              postId === liveId ||
              videoId === liveId;

            if (liveId && !isFromLive) {
              console.log(`⏸️ Comment not from active live (${liveId}) — ignoring`);
              return;
            }

            await processComment(senderPsid, senderName, message, commentId);
          }
        }
      }
    }
  }
});

// ── Health Check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'LiveOrder Server running! 🔴', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LiveOrder Server running on port ${PORT}`));
