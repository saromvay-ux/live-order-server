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

// ── Helper: Get Shop Profile Payment Details ──────────────
async function getShopProfile() {
  try {
    const snap = await db.collection('settings').doc('shop_profile').get();
    if (!snap.exists) return { phone: "", aba: "", aclida: "" };
    return snap.data();
  } catch(e) {
    return { phone: "", aba: "", aclida: "" };
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
async function getPriceRangeOwner(code, liveVideoId) {
  const snap = await db.collection('orders')
    .where('code', '==', code)
    .where('type', '==', 'price_range')
    .get();
    
  if (snap.empty) return null;
  
  // Filter by matching stream ID in memory to ensure separate stream ownership
  const targetLiveId = liveVideoId || "general";
  const match = snap.docs
    .map(d => d.data())
    .find(order => order.liveVideoId === targetLiveId);
    
  return match ? match.userName : null;
}

// ── Helper: Get all orders for user IN THIS STREAM ONLY (Safe Memory Filter) ───
async function getUserOrders(userName, liveVideoId) {
  const snap = await db.collection('orders')
    .where('userName', '==', userName)
    .get();
  
  if (snap.empty) return [];

  // Match fallback strings accurately so streams isolate cleanly
  const targetLiveId = liveVideoId || "general";

  return snap.docs
    .map(d => d.data())
    .filter(order => order.liveVideoId === targetLiveId) 
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
}

// ── Helper: Send Messenger Message (via PSID) ─────────────
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
async function sendPrivateReply(commentId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/me/messages`,
      {
        recipient: { comment_id: commentId },
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
function buildOrderMessage(userName, orders, sellerPhone, sellerAba, sellerAclida) {
  const deliveryFee = 2.00; 
  const exchangeRate = 4000; // 1$ = 4000 Riel

  const phone  = sellerPhone  || "";
  const aba    = sellerAba    || "";
  const aclida = sellerAclida || "";

  const lines = orders.map(o => {
    const qty   = o.qty   || 1;
    const price = o.price || 0;
    return `📦 កូដ #${o.code} × ${qty} = $${(qty * price).toFixed(2)}`;
  }).join('\n');
  
  const subtotal = orders.reduce((s, o) => s + ((o.qty || 1) * (o.price || 0)), 0);
  const totalAllUsd = subtotal + deliveryFee;
  const totalAllRiel = totalAllUsd * exchangeRate;
  const formattedRiel = totalAllRiel.toLocaleString('en-US');

  return `🙏សួរស្តីបង!👤 ${userName}\n✅បងបានបញ្ជាទិញ\n━━━━━━━━━━━━━\n${lines}\n🚚 ថ្លៃសេវាដឹកជញ្ជូន: $${deliveryFee.toFixed(2)}\n━━━━━━━━━━━━━\n💵 សរុបទាំងអស់: $${totalAllUsd.toFixed(2)}\n💵 សរុបទាំងអស់: ${formattedRiel} រៀល\n📞 លេខទូរស័ព្ទ: ${phone}\n🏦 គណនី ABA: ${aba}\n✨ គណនី ACLEDA: ${aclida}\n\n🙏 អរគុណសម្រាប់ការបញ្ជាទិញ!`;
}

// ── Helper: Parse comment ─────────────────────────────────
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
async function smartSend(senderPsid, commentId, message) {
  if (senderPsid && senderPsid !== 'unknown') {
    const sent = await sendMessengerMessage(senderPsid, message);
    if (sent) return;
  }

  if (commentId) {
    const sent = await sendPrivateReply(commentId, message);
    if (sent) return;
  }

  if (commentId) {
    const shortMsg = `សួស្តី! ទទួលបានការបញ្ជាទិញ ✅\nសូម Chat មកផេក ដើម្បីទទួលព័ត៌មានលម្អិត 🛍️`;
    await replyOnComment(commentId, shortMsg);
  }
}

// ── Process Comment ───────────────────────────────────────
async function processComment(senderPsid, senderName, message, commentId, liveVideoId) {
  // 🌟 Safety fallback fallback variable so it never triggers undefined crashes
  const activeLiveId = liveVideoId || "general"; 
  console.log(`💬 ${senderName} (${senderPsid}): ${message} [Stream: ${activeLiveId}]`);

  const parsed = parseComment(message);
  if (!parsed) return;

  const { code, qty } = parsed;
  const userName = senderName || 'User_' + senderPsid.slice(-6);

  const profile = await getShopProfile();

  // ── Check Stock Code first ────────────────────────────
  const stockCode = await getStockCode(code);
  if (stockCode) {
    if (stockCode.remainingQty <= 0) {
      console.log(`❌ Code #${code} is SOLD OUT`);
      await db.collection('rejected_orders').add({
        attemptedBy: userName,
        liveVideoId: activeLiveId,
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
        liveVideoId: activeLiveId,
        code, qty,
        reason: 'INSUFFICIENT_STOCK',
        remainingQty: stockCode.remainingQty,
        createdAt: new Date()
      });
      return;
    }

    // Deduct stock atomically
    await db.collection('stock_codes').doc(stockCode.id).update({
      remainingQty: FieldValue.increment(-qty),
      soldQty: FieldValue.increment(qty)
    });

    // Save order tagged with active stream context
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

    const allOrders = await getUserOrders(userName, activeLiveId);
    const msg = buildOrderMessage(userName, allOrders, profile.phone, profile.aba, profile.aclida);
    await smartSend(senderPsid, commentId, msg);
    return;
  }

  // ── Check Price Range ─────────────────────────────────
  const price = await getPriceRangeForCode(code);
  if (!price) return;

  if (qty > 1) {
    console.log(`❌ Price range code #${code} only allows qty=1`);
    return;
  }

  const owner = await getPriceRangeOwner(code, activeLiveId);
  if (owner) {
    console.log(`❌ Code #${code} already taken by ${owner} in this stream`);
    await db.collection('rejected_orders').add({
      attemptedBy: userName,
      liveVideoId: activeLiveId,
      code,
      ownedBy: owner,
      reason: 'CODE_TAKEN',
      createdAt: new Date()
    });
    return;
  }

  // Save price range order tagged with active stream context
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

  const allOrders = await getUserOrders(userName, activeLiveId);
  const msg = buildOrderMessage(userName, allOrders, profile.phone, profile.aba, profile.aclida);
  await smartSend(senderPsid, commentId, msg);
}

// ── Handle Incoming Messenger Message ────────────────────
async function handleIncomingMessage(psid, message) {
  try {
    const liveMode = await getLiveMode();
    const activeVideoId = liveMode ? (liveMode.liveVideoId || "general") : "general";

    const sentRef  = db.collection('message_sent_log').doc(psid);
    const sentSnap = await sentRef.get();
    const lastSentCount = sentSnap.exists ? (sentSnap.data().orderCount || 0) : -1;

    const snap = await db.collection('orders')
      .where('fbUserId', '==', psid)
      .get();

    const profile = await getShopProfile();

    if (snap.empty) {
      if (lastSentCount === -1) {
        await sendMessengerMessage(psid,
          'សួស្តី! 👋\nអរគុណដែលបានទំនាក់ទំនងមកកាន់យើង!\n\nប្រសិនបើអ្នកចង់បញ្ជាទិញ សូមរង់ចាំការ Live លក់របស់យើង! 🛍️'
        );
        await sentRef.set({ lastSentAt: new Date(), orderCount: 0 });
      }
      return;
    }

    // Filter dynamic collections on runtime memory array structure
    const orders = snap.docs
      .map(d => d.data())
      .filter(order => order.liveVideoId === activeVideoId)
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));

    if (orders.length === 0) return;

    if (orders.length <= lastSentCount) {
      console.log(`No new orders for ${psid} — skip`);
      return;
    }

    const userName = orders[0].userName || 'បងប្អូន';
    const msg      = buildOrderMessage(userName, orders, profile.phone, profile.aba, profile.aclida);
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

            const liveMode = await getLiveMode();
            if (!liveMode) {
              console.log(`⏸️ Live Mode OFF — ignoring comment from ${senderName}`);
              return;
            }

            const postId     = val.post_id || '';
            const liveId     = liveMode.liveVideoId || '';
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

            // Forward video id context downstream explicitly
            await processComment(senderPsid, senderName, message, commentId, liveId);
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
