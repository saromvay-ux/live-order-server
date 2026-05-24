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
const seenMessageIds = new Set();

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
    return data;
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

// ── Helper: Send Messenger Message (via PSID) ─────────────
// Works for customers who have messaged your page before
async function sendMessengerMessage(psid, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/me/messages`,
      {
        recipient: { id: psid },
        message: { text: message },
        messaging_type: 'RESPONSE'
      },
      { params: { access_token: PAGE_TOKEN } }
    );
    console.log(`✅ Messenger DM sent to PSID: ${psid}`);
    return true;
  } catch(e) {
    console.error('❌ Messenger DM error:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

// ── Helper: Send Private Reply (via Comment ID) ───────────
// Works for ALL customers who comment — no prior messaging needed!
// Uses Facebook Private Reply API — sends DM privately to commenter
async function sendPrivateReply(commentId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/me/messages`,
      {
        recipient: { comment_id: commentId },  // ← private reply via comment ID
        message: { text: message },
        messaging_type: 'RESPONSE'
      },
      { params: { access_token: PAGE_TOKEN } }
    );
    console.log(`✅ Private reply sent for comment: ${commentId}`);
    return true;
  } catch(e) {
    console.error('❌ Private reply error:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

// ── Helper: Reply Publicly on Comment ────────────────────
// Last resort fallback — public comment reply
async function replyOnComment(commentId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${commentId}/comments`,
      { message },
      { params: { access_token: PAGE_TOKEN } }
    );
    console.log(`✅ Public comment reply sent`);
    return true;
  } catch(e) {
    console.error('❌ Comment reply error:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

// ── Helper: Build order message ───────────────────────────
function buildOrderMessage(userName, orders) {
  const lines = orders.map(o => {
    const qty   = o.qty   || 1;
    const price = o.price || 0;
    return `📦 កូដ #${o.code} × ${qty} = $${(qty * price).toFixed(2)}`;
  }).join('\n');
  const total = orders.reduce((s, o) => s + ((o.qty || 1) * (o.price || 0)), 0);
  return `✅ បានទទួលការបញ្ជាទិញ!\n\n👤 ${userName}\n━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━\n💵 សរុបទាំងអស់: $${total.toFixed(2)}\n\n🙏 អរគុណសម្រាប់ការបញ្ជាទិញ!`;
}

// ── Helper: Parse comment ─────────────────────────────────
// Valid: "34"    → { code: 34, qty: 1 }
// Valid: "34=2"  → { code: 34, qty: 2 }
// Invalid: anything else → null
function parseComment(text) {
  const trimmed = text.trim();

  // Format: code=qty
  const matchEq = trimmed.match(/^(\d+)=(\d+)$/);
  if (matchEq) {
    const code = parseInt(matchEq[1]);
    const qty  = parseInt(matchEq[2]);
    if (qty < 1) return null;
    return { code, qty };
  }

  // Format: code only
  const matchNum = trimmed.match(/^(\d+)$/);
  if (matchNum) {
    return { code: parseInt(matchNum[1]), qty: 1 };
  }

  return null;
}

// ── Helper: Smart Send ────────────────────────────────────
// Strategy:
// 1. Try sendMessengerMessage via PSID (existing customers)
// 2. If fails → try sendPrivateReply via commentId (new customers) ✅
// 3. If fails → fallback to public comment reply
async function smartSend(senderPsid, commentId, message) {
  // Step 1: Try DM via PSID
  if (senderPsid && senderPsid !== 'unknown') {
    const sent = await sendMessengerMessage(senderPsid, message);
    if (sent) return; // ✅ Done!
  }

  // Step 2: Try Private Reply via commentId (works for ALL new customers!)
  if (commentId) {
    const sent = await sendPrivateReply(commentId, message);
    if (sent) return; // ✅ Done!
  }

  // Step 3: Last resort — public comment reply (short message)
  if (commentId) {
    const shortMsg = `សួស្តី! ទទួលបានការបញ្ជាទិញ ✅\nសូម Chat មកផេក ដើម្បីទទួលព័ត៌មានលម្អិត 🛍️`;
    await replyOnComment(commentId, shortMsg);
  }
}

// ── Process Comment ───────────────────────────────────────
async function processComment(senderPsid, senderName, message, commentId,liveVideoId) {
  console.log(`💬 ${senderName} (${senderPsid}): ${message} [Stream: ${liveVideoId}]`);

  // 🌟 THE FIX: If liveVideoId is empty/undefined, default to "general" so Firestore never crashes!
  const activeLiveId = liveVideoId || "general";

  const parsed = parseComment(message);
  if (!parsed) return; // invalid format — silent ignore

  const { code, qty } = parsed;
  const userName = senderName || 'User_' + senderPsid.slice(-6);

  // ── Check Stock Code first ────────────────────────────
  const stockCode = await getStockCode(code);
  if (stockCode) {
    if (stockCode.remainingQty <= 0) {
      console.log(`❌ Code #${code} is SOLD OUT`);
      await db.collection('rejected_orders').add({
        attemptedBy: userName,
        code, qty,
        reason: 'SOLD_OUT',
        createdAt: new Date()
      });
      return;
    }

    if (qty > stockCode.remainingQty) {
      console.log(`❌ Not enough stock for #${code}. Requested: ${qty}, Remaining: ${stockCode.remainingQty}`);
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
      liveVideoId: activeLiveId,
      code,
      price: stockCode.price,
      qty,
      type: 'stock_code',
      source: 'facebook_live',
      createdAt: new Date()
    });
    console.log(`✅ Stock order: ${userName} → #${code} × ${qty} @ $${stockCode.price}`);

    // ✅ Send message (smart: DM → private reply → public comment)
    const allOrders = await getUserOrders(userName);
    const msg = buildOrderMessage(userName, allOrders);
    await smartSend(senderPsid, commentId, msg);
    return;
  }

  // ── Check Price Range ─────────────────────────────────
  const price = await getPriceRangeForCode(code);
  if (!price) return; // code not found — silent ignore

  // Price range: only qty=1 allowed
  if (qty > 1) {
    console.log(`❌ Price range code #${code} only allows qty=1`);
    return;
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
    liveVideoId: activeLiveId,
    code,
    price,
    qty: 1,
    type: 'price_range',
    source: 'facebook_live',
    createdAt: new Date()
  });
  console.log(`✅ Price range order: ${userName} → #${code} @ $${price}`);

  // ✅ Send message (smart: DM → private reply → public comment)
  const allOrders = await getUserOrders(userName);
  const msg = buildOrderMessage(userName, allOrders);
  await smartSend(senderPsid, commentId, msg);
}

// ── Handle Incoming Messenger Message ────────────────────
async function handleIncomingMessage(psid, message) {
  try {
    const sentRef  = db.collection('message_sent_log').doc(psid);
    const sentSnap = await sentRef.get();
    const lastSentCount = sentSnap.exists ? (sentSnap.data().orderCount || 0) : -1;

    const snap = await db.collection('orders')
      .where('fbUserId', '==', psid)
      .orderBy('createdAt', 'asc')
      .get();

    if (snap.empty) {
      if (lastSentCount === -1) {
        await sendMessengerMessage(psid,
          'សួស្តី! 👋\nអរគុណដែលបានទំនាក់ទំនងមកកាន់យើង!\n\nប្រសិនបើអ្នកចង់បញ្ជាទិញ សូមរង់ចាំការ Live លក់របស់យើង! 🛍️'
        );
        await sentRef.set({ lastSentAt: new Date(), orderCount: 0 });
      }
      return;
    }

    const orders = snap.docs.map(d => d.data());

    if (orders.length <= lastSentCount) {
      console.log(`No new orders for ${psid} — skip`);
      return;
    }

    const userName = orders[0].userName || 'បងប្អូន';
    const msg      = buildOrderMessage(userName, orders);
    await sendMessengerMessage(psid, msg);
    await sentRef.set({ lastSentAt: new Date(), orderCount: orders.length });
    console.log(`Summary sent to ${psid} (${orders.length} orders)`);

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

      // ── Messenger messages ──────────────────────────────
      for (const event of entry.messaging || []) {
        if (event.message && !event.message.is_echo) {
          const psid    = event.sender.id;
          const message = (event.message.text || '').trim();
          const mid     = event.message.mid || '';

          if (mid && seenMessageIds.has(mid)) {
            console.log(`⏭️ Duplicate skipped: ${mid}`);
            continue;
          }
          if (mid) seenMessageIds.add(mid);

          console.log(`📨 Messenger from ${psid}: ${message}`);
          await handleIncomingMessage(psid, message);
        }
      }

      // ── Feed / Live comments ────────────────────────────
      for (const change of entry.changes || []) {
        if (change.field === 'feed' || change.field === 'live_videos') {
          const val = change.value;
          if (val.item === 'comment' && val.verb === 'add') {
            const commentId  = val.comment_id;
            const message    = val.message || '';
            const senderName = val.from?.name || 'User_' + (val.from?.id || 'unknown').slice(-6);
            const senderPsid = val.from?.id || 'unknown';

            // Check Live Mode
            const liveMode = await getLiveMode();
            if (!liveMode) {
              console.log(`⏸️ Live Mode OFF — ignoring comment from ${senderName}`);
              return;
            }

            // Check if comment is from active live video
            const postId     = val.post_id || '';
            const liveId     = liveMode.liveVideoId;
            const livePostId = liveMode.livePostId || '';

            const numericPostId = postId.includes('_') ? postId.split('_')[1] : postId;

            const isFromLive =
              numericPostId === liveId ||
              numericPostId === livePostId ||
              postId.includes(liveId) ||
              postId.includes(livePostId) ||
              commentId.includes(liveId);

            if (liveId && !isFromLive) {
              console.log(`⏸️ Not from active live — postId=${numericPostId} liveId=${liveId}`);
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
  res.json({
    status: 'ok',
    message: 'LiveOrder Server running! 🔴',
    time: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LiveOrder Server running on port ${PORT}`));
