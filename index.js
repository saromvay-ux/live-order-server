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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'liveorder_verify_2024';

// ── Rate Limiting ─────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX    = 60;
const RATE_LIMIT_WINDOW = 60 * 1000;

function isRateLimited(ip) {
  const now  = Date.now();
  const data = rateLimitMap.get(ip);
  if (!data || now > data.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return false;
  }
  data.count++;
  if (data.count > RATE_LIMIT_MAX) {
    console.warn(`⚠️ Rate limit exceeded for IP: ${ip} (${data.count} requests)`);
    return true;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

function webhookRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket?.remoteAddress
           || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
  next();
}

// ── Token Cache (avoid reading Firebase on every comment) ─
// Cache tokens for 5 minutes to reduce Firebase reads
const tokenCache = new Map(); // pageId → { token, sellerId, cachedAt }
const TOKEN_CACHE_TTL = 1 * 60 * 1000; // 1 minutes

// ── Helper: Get seller token by pageId ───────────────────
// Looks up which seller owns this pageId and returns their token
// This allows multiple sellers with different pages to work simultaneously
async function getSellerByPageId(pageId) {
  // Check cache first
  const cached = tokenCache.get(pageId);
  if (cached && Date.now() - cached.cachedAt < TOKEN_CACHE_TTL) {
    return cached;
  }

  try {
    // Search in root fb_profiles (admin/your own page)
    const rootSnap = await db.collection('fb_profiles')
      .where('pageId', '==', pageId)
      .limit(1)
      .get();

    if (!rootSnap.empty) {
      const data = rootSnap.docs[0].data();
      const result = { token: data.pageToken, sellerId: null, isRoot: true };
      tokenCache.set(pageId, { ...result, cachedAt: Date.now() });
      return result;
    }

    // Search in all sellers' fb_profiles subcollections
    const sellersSnap = await db.collection('sellers').get();
    for (const sellerDoc of sellersSnap.docs) {
      const profilesSnap = await db.collection('sellers')
        .doc(sellerDoc.id)
        .collection('fb_profiles')
        .where('pageId', '==', pageId)
        .limit(1)
        .get();

      if (!profilesSnap.empty) {
        const data = profilesSnap.docs[0].data();
        const result = { token: data.pageToken, sellerId: sellerDoc.id, isRoot: false };
        tokenCache.set(pageId, { ...result, cachedAt: Date.now() });
        return result;
      }
    }
  } catch(e) {
    console.error('❌ getSellerByPageId error:', e.message);
  }

  // Fallback to env variable for backward compatibility
  const fallbackToken = process.env.PAGE_TOKEN;
  if (fallbackToken) {
    return { token: fallbackToken, sellerId: null, isRoot: true };
  }

  return null;
}

// ── Helper: Get correct Firestore collection path ─────────
// Returns scoped path based on sellerId (null = root/admin)
function sellerCol(sellerId, colName) {
  if (!sellerId) return db.collection(colName);
  return db.collection('sellers').doc(sellerId).collection(colName);
}
function sellerSettingsDoc(sellerId, docName) {
  if (!sellerId) return db.collection('settings').doc(docName);
  return db.collection('sellers').doc(sellerId).collection('settings').doc(docName);
}

// ── Helper: Get Live Mode Status (scoped to seller) ───────
async function getLiveMode(sellerId) {
  try {
    const snap = await sellerSettingsDoc(sellerId, 'live_mode').get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data.active) return null;
    return data;
  } catch(e) {
    return null;
  }
}

// ── Helper: Get Shop Profile Payment Details ──────────────
async function getShopProfile(sellerId) {
  try {
    const snap = await sellerSettingsDoc(sellerId, 'shop_profile').get();
    if (!snap.exists) return { phone: "", aba: "", aclida: "" };
    return snap.data();
  } catch(e) {
    return { phone: "", aba: "", aclida: "" };
  }
}

// ── Helper: Get price range for code ─────────────────────
async function getPriceRangeForCode(code, sellerId) {
  const snap = await sellerCol(sellerId, 'price_ranges').get();
  for (const doc of snap.docs) {
    const r = doc.data();
    if (code >= r.from && code <= r.to) return r.price;
  }
  return null;
}

// ── Helper: Get stock code ────────────────────────────────
async function getStockCode(code, sellerId) {
  const snap = await sellerCol(sellerId, 'stock_codes')
    .where('code', '==', code)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// ── Helper: Get owner of price range code ─────────────────
async function getPriceRangeOwner(code, liveVideoId, sellerId) {
  const snap = await sellerCol(sellerId, 'orders')
    .where('code', '==', code)
    .where('type', '==', 'price_range')
    .get();
  if (snap.empty) return null;
  const targetLiveId = liveVideoId || "general";
  const match = snap.docs
    .map(d => d.data())
    .find(order => order.liveVideoId === targetLiveId);
  return match ? match.userName : null;
}

// ── Helper: Get all orders for user IN THIS STREAM ONLY ───
async function getUserOrders(userName, liveVideoId, sellerId) {
  const snap = await sellerCol(sellerId, 'orders')
    .where('userName', '==', userName)
    .get();
  if (snap.empty) return [];
  const targetLiveId = liveVideoId || "general";
  return snap.docs
    .map(d => d.data())
    .filter(order => order.liveVideoId === targetLiveId)
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
}

// ── Helper: Send Messenger Message (via PSID) ─────────────
async function sendMessengerMessage(psid, message, token) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/me/messages`,
      { recipient: { id: psid }, message: { text: message }, messaging_type: 'RESPONSE' },
      { params: { access_token: token } }
    );
    console.log(`✅ Messenger DM sent to PSID: ${psid}`);
    return true;
  } catch(e) {
    console.error('❌ Messenger DM error:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

// ── Helper: Send Private Reply (via Comment ID) ───────────
async function sendPrivateReply(commentId, message, token) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/me/messages`,
      { recipient: { comment_id: commentId }, message: { text: message }, messaging_type: 'RESPONSE' },
      { params: { access_token: token } }
    );
    console.log(`✅ Private reply sent for comment: ${commentId}`);
    return true;
  } catch(e) {
    console.error('❌ Private reply error:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

// ── Helper: Reply Publicly on Comment ────────────────────
async function replyOnComment(commentId, message, token) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${commentId}/comments`,
      { message },
      { params: { access_token: token } }
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
  const deliveryFee    = 2.00;
  const exchangeRate   = 4000;
  const phone          = sellerPhone  || "";
  const aba            = sellerAba    || "";
  const aclida         = sellerAclida || "";

  const lines = orders.map(o => {
    const qty   = o.qty   || 1;
    const price = o.price || 0;
    return `🛍️ កូដ #${o.code} × ${qty} = $${(qty * price).toFixed(2)}`;
  }).join('\n');

  const subtotal      = orders.reduce((s, o) => s + ((o.qty || 1) * (o.price || 0)), 0);
  const totalAllUsd   = subtotal + deliveryFee;
  const totalAllRiel  = totalAllUsd * exchangeRate;
  const formattedRiel = totalAllRiel.toLocaleString('en-US');

  return `🙏សួរស្តីបង!👤 ${userName}\n🛒បងបានបញ្ជាទិញ\n━━━━━━━━━━━━━\n${lines}\n🚚 ថ្លៃសេវាដឹកជញ្ជូន: $${deliveryFee.toFixed(2)}\n━━━━━━━━━━━━━\n💵 សរុបទាំងអស់($): $${totalAllUsd.toFixed(2)}\n💵 សរុបទាំងអស់(៛): ${formattedRiel} រៀល\n📞 លេខទូរស័ព្ទ: ${phone}\n🏦 គណនី ABA: ${aba}\n✨ គណនី ACLEDA: ${aclida}\n\n🙏 អរគុណសម្រាប់ការបញ្ជាទិញ🥰!`;
}

// ── Helper: Parse comment ─────────────────────────────────
function parseComment(text) {
  const trimmed = text.trim();

  const matchEq = trimmed.match(/^([A-Za-z0-9]+)=(\d+)$/);
  if (matchEq) {
    const code = matchEq[1].toUpperCase();
    const qty  = parseInt(matchEq[2]);
    if (qty < 1) return null;
    return { code, qty };
  }

  const matchNum = trimmed.match(/^([A-Za-z0-9]+)$/);
  if (matchNum) {
    return { code: matchNum[1].toUpperCase(), qty: 1 };
  }

  return null;
}

// ── Helper: Smart Send ────────────────────────────────────
async function smartSend(senderPsid, commentId, message, token) {
  if (senderPsid && senderPsid !== 'unknown') {
    const sent = await sendMessengerMessage(senderPsid, message, token);
    if (sent) return;
  }
  if (commentId) {
    const sent = await sendPrivateReply(commentId, message, token);
    if (sent) return;
  }
  if (commentId) {
    const shortMsg = `សួស្តី! ទទួលបានការបញ្ជាទិញ ✅\nសូម Chat មកផេក ដើម្បីទទួលព័ត៌មានលម្អិត 🛍️`;
    await replyOnComment(commentId, shortMsg, token);
  }
}

// ── Process Comment ───────────────────────────────────────
async function processComment(senderPsid, senderName, message, commentId, liveVideoId, sellerId, token) {
  const activeLiveId = liveVideoId || "general";
  console.log(`💬 ${senderName} (${senderPsid}): ${message} [Stream: ${activeLiveId}] [Seller: ${sellerId || 'root'}]`);

  const parsed = parseComment(message);
  if (!parsed) return;

  const { code, qty } = parsed;
  const userName = senderName || 'User_' + senderPsid.slice(-6);
  const profile  = await getShopProfile(sellerId);

  // ── Check Stock Code first ────────────────────────────
  const stockCode = await getStockCode(code, sellerId);
  if (stockCode) {
    if (stockCode.remainingQty <= 0) {
      console.log(`❌ Code #${code} is SOLD OUT`);
      await sellerCol(sellerId, 'rejected_orders').add({
        attemptedBy: userName, liveVideoId: activeLiveId,
        code, qty, reason: 'SOLD_OUT', createdAt: new Date()
      });
      return;
    }

    if (qty > stockCode.remainingQty) {
      console.log(`❌ Not enough stock for #${code}. Requested: ${qty}, Remaining: ${stockCode.remainingQty}`);
      await sellerCol(sellerId, 'rejected_orders').add({
        attemptedBy: userName, liveVideoId: activeLiveId,
        code, qty, reason: 'INSUFFICIENT_STOCK',
        remainingQty: stockCode.remainingQty, createdAt: new Date()
      });
      return;
    }

    await sellerCol(sellerId, 'stock_codes').doc(stockCode.id).update({
      remainingQty: FieldValue.increment(-qty),
      soldQty: FieldValue.increment(qty)
    });

    await sellerCol(sellerId, 'orders').add({
      userName, fbUserId: senderPsid,
      liveVideoId: activeLiveId,
      code, price: stockCode.price, qty,
      type: 'stock_code', source: 'facebook_live',
      createdAt: new Date()
    });
    console.log(`✅ Stock order: ${userName} → #${code} × ${qty} @ $${stockCode.price}`);

    const allOrders = await getUserOrders(userName, activeLiveId, sellerId);
    const msg = buildOrderMessage(userName, allOrders, profile.phone, profile.aba, profile.aclida);
    await smartSend(senderPsid, commentId, msg, token);
    return;
  }

  // ── Check Price Range ─────────────────────────────────
  const price = await getPriceRangeForCode(code, sellerId);
  if (!price) return;

  if (qty > 1) {
    console.log(`❌ Price range code #${code} only allows qty=1`);
    return;
  }

  const owner = await getPriceRangeOwner(code, activeLiveId, sellerId);
  if (owner) {
    console.log(`❌ Code #${code} already taken by ${owner} in this stream`);
    await sellerCol(sellerId, 'rejected_orders').add({
      attemptedBy: userName, liveVideoId: activeLiveId,
      code, ownedBy: owner, reason: 'CODE_TAKEN',
      createdAt: new Date()
    });
    return;
  }

  await sellerCol(sellerId, 'orders').add({
    userName, fbUserId: senderPsid,
    liveVideoId: activeLiveId,
    code, price, qty: 1,
    type: 'price_range', source: 'facebook_live',
    createdAt: new Date()
  });
  console.log(`✅ Price range order: ${userName} → #${code} @ $${price}`);

  const allOrders = await getUserOrders(userName, activeLiveId, sellerId);
  const msg = buildOrderMessage(userName, allOrders, profile.phone, profile.aba, profile.aclida);
  await smartSend(senderPsid, commentId, msg, token);
}

// ── Handle Incoming Messenger Message ────────────────────
async function handleIncomingMessage(psid, message, sellerId, token) {
  try {
    const liveMode      = await getLiveMode(sellerId);
    const activeVideoId = liveMode ? (liveMode.liveVideoId || "general") : "general";

    const sentRef       = sellerCol(sellerId, 'message_sent_log').doc(psid);
    const sentSnap      = await sentRef.get();
    const lastSentCount = sentSnap.exists ? (sentSnap.data().orderCount || 0) : -1;

    const snap    = await sellerCol(sellerId, 'orders').where('fbUserId', '==', psid).get();
    const profile = await getShopProfile(sellerId);

    if (snap.empty) {
      if (lastSentCount === -1) {
        await sendMessengerMessage(psid,
          'សួស្តី! 👋\nអរគុណដែលបានទំនាក់ទំនងមកកាន់យើង!\n\nប្រសិនបើអ្នកចង់បញ្ជាទិញ សូមរង់ចាំការ Live លក់របស់យើង! 🛍️',
          token
        );
        await sentRef.set({ lastSentAt: new Date(), orderCount: 0 });
      }
      return;
    }

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
    await sendMessengerMessage(psid, msg, token);
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

// ── Webhook Events (with rate limiting) ───────────────────
app.post('/webhook', webhookRateLimit, async (req, res) => {
  const body = req.body;
  res.sendStatus(200);

  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      // Get pageId from entry to identify which seller
      const entryPageId = entry.id || '';

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

          // Find seller by pageId
          const seller = await getSellerByPageId(entryPageId);
          if (!seller) {
            console.log(`⚠️ No seller found for pageId: ${entryPageId}`);
            continue;
          }

          console.log(`📨 Messenger from ${psid}: ${message} [Page: ${entryPageId}]`);
          await handleIncomingMessage(psid, message, seller.sellerId, seller.token);
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

            // Find seller by pageId from entry
            const seller = await getSellerByPageId(entryPageId);
            if (!seller) {
              console.log(`⚠️ No seller found for pageId: ${entryPageId}`);
              continue;
            }

            const liveMode = await getLiveMode(seller.sellerId);
            if (!liveMode) {
              console.log(`⏸️ Live Mode OFF — ignoring comment from ${senderName} [Page: ${entryPageId}]`);
              continue;
            }

            const postId        = val.post_id || '';
            const liveId        = liveMode.liveVideoId || '';
            const livePostId    = liveMode.livePostId  || '';
            const numericPostId = postId.includes('_') ? postId.split('_')[1] : postId;

            const isFromLive =
              numericPostId === liveId ||
              numericPostId === livePostId ||
              postId.includes(liveId) ||
              postId.includes(livePostId) ||
              commentId.includes(liveId);

            if (liveId && !isFromLive) {
              console.log(`⏸️ Not from active live — postId=${numericPostId} liveId=${liveId}`);
              continue;
            }

            await processComment(senderPsid, senderName, message, commentId, liveId, seller.sellerId, seller.token);
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
