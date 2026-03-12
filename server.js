require('dotenv').config();
const express      = require('express');
const mongoose     = require('mongoose');
const axios        = require('axios');
const jwt          = require('jsonwebtoken');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');
const { ObjectId } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT  = process.env.JWT_SECRET || 'emirates_secret_2024';

const GUILD_ID  = process.env.DISCORD_GUILD_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

/* ─────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────── */
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'https://giorgio.is-a.dev',
    'http://localhost:3000'
  ].filter(Boolean),
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

/* ─────────────────────────────────────────
   MONGODB
───────────────────────────────────────── */
let db;
mongoose.connect(process.env.MONGODB_URI)
  .then(() => { db = mongoose.connection.db; console.log('✅ MongoDB connected'); })
  .catch(err => console.error('❌ MongoDB error:', err));

/* ─────────────────────────────────────────
   DYNAMIC PRICING
───────────────────────────────────────── */
const SEAT_TOTALS  = { economy: 15, business: 15, first: 15 };
const BASE_PRICES  = { economy: 299, business: 1499, first: 3999 };

function dynamicPrice(cls, available) {
  const total = SEAT_TOTALS[cls] || 150;
  const base  = BASE_PRICES[cls] || 299;
  const fill  = Math.max(0, 1 - (available / total)); // 0 = empty, 1 = full
  const multiplier = 1 + fill * 1.8;                  // up to 2.8x when full
  return Math.round(base * multiplier / 10) * 10;      // round to nearest $10
}

/* ─────────────────────────────────────────
   SEAT TRACKING — lazy init per flight
───────────────────────────────────────── */
async function getSeats(flightId) {
  const id = flightId.toString();
  let doc = await db.collection('flightSeats').findOne({ flightId: id });
  if (!doc) {
    doc = { flightId: id, economy: 15, business: 15, first: 15 };
    await db.collection('flightSeats').insertOne(doc);
  }
  return {
    economy:  Math.max(0, doc.economy  ?? 15),
    business: Math.max(0, doc.business ?? 15),
    first:    Math.max(0, doc.first    ?? 15)
  };
}

/* ─────────────────────────────────────────
   NORMALIZERS — map bot schema → frontend
───────────────────────────────────────── */
function normFlight(f, seats) {
  if (!f) return null;
  const miles  = f.skywardsMiles || 1000;
  const s      = seats || { economy: 150, business: 30, first: 14 };
  return {
    _id:             f._id,
    flightNumber:    f.fnum,
    origin:          f.departure,
    originCity:      f.departure,
    destination:     f.arrival,
    destinationCity: f.arrival,
    departureTime:   new Date((f.time || 0) * 1000),
    aircraft:        f.aircraft  || '—',
    status:          (f.status   || 'SCHEDULED').toLowerCase(),
    route:           f.route     || `${f.departure}-${f.arrival}`,
    codeshare:       f.codeshare || null,
    imageUrl:        f.imageUrl  || null,
    eventUrl:        f.eventUrl  || null,
    skywardsMiles:   miles,
    seats:           s,
    classes: {
      economy:  { price: dynamicPrice('economy',  s.economy),  availableSeats: s.economy,  totalSeats: 15 },
      business: { price: dynamicPrice('business', s.business), availableSeats: s.business, totalSeats: 15 },
      first:    { price: dynamicPrice('first',    s.first),    availableSeats: s.first,    totalSeats: 15 }
    },
    milesEarned: {
      economy:  Math.round(miles * 0.5),
      business: Math.round(miles * 0.8),
      first:    miles
    }
  };
}

// Bot rewards: _id = discordId string
function normRewards(r, discordId) {
  if (!r) return null;
  return {
    discordId,
    skywardsNumber:   `EK${discordId}`.substring(0, 12),
    tier:             r.tier             || 'Blue',
    availableMiles:   r.miles            || 0,
    totalMilesEarned: r.lifetimeMiles    || r.miles || 0,
    flightsCompleted: r.flightsCompleted || 0,
    achievements:     r.achievements     || [],
    transactions:     []
  };
}

async function normBooking(b) {
  let flight = null;
  if (b.fnum) {
    const fnumClean = b.fnum.split('/')[0].trim();
    flight = await db.collection('flights').findOne({ fnum: { $regex: fnumClean, $options: 'i' } });
  }
  return {
    _id:             b._id,
    discordId:       b.discordId,
    pnr:             b.code,
    flightNumber:    b.fnum,
    class:           (b.class || 'economy').toLowerCase(),
    status:          b.checkedIn ? 'checked-in' : (b.status || 'confirmed'),
    origin:          flight?.departure || '—',
    originCity:      flight?.departure || '—',
    destination:     flight?.arrival   || '—',
    destinationCity: flight?.arrival   || '—',
    departureTime:   flight ? new Date(flight.time * 1000) : (b.bookedAt || new Date()),
    aircraft:        flight?.aircraft  || '—',
    milesEarned:     flight?.skywardsMiles || 0,
    price:           b.price || 0,
    passengers:      b.robloxUser ? [{ firstName: b.robloxUser, lastName: '' }] : (b.passengers || []),
    seatNumbers:     b.seat ? [b.seat] : [],
    bookedAt:        b.bookedAt || b.createdAt || new Date()
  };
}

/* ─────────────────────────────────────────
   DISCORD ROLE → CLASS ACCESS
   Roles (case-insensitive match):
     first / very important / vip → 'first'
     business / premium           → 'business'
     economy / (default)          → 'economy'
───────────────────────────────────────── */
async function resolveClassAccess(access_token) {
  if (!GUILD_ID || !BOT_TOKEN) return { classAccess: 'economy', roleName: 'Economy' };
  try {
    const [memberRes, rolesRes] = await Promise.all([
      axios.get(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, {
        headers: { Authorization: `Bearer ${access_token}` }
      }),
      axios.get(`https://discord.com/api/guilds/${GUILD_ID}/roles`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      })
    ]);

    const userRoleIds = memberRes.data.roles || [];
    const guildRoles  = rolesRes.data || [];

    const userRoles = guildRoles
      .filter(r => userRoleIds.includes(r.id))
      .map(r => ({ id: r.id, name: r.name, position: r.position }))
      .sort((a, b) => b.position - a.position); // highest position first

    for (const role of userRoles) {
      const n = role.name.toLowerCase();
      if (n.includes('first') || n.includes('very important') || n.includes('vip')) {
        return { classAccess: 'first', roleName: role.name };
      }
    }
    for (const role of userRoles) {
      const n = role.name.toLowerCase();
      if (n.includes('business') || n.includes('premium')) {
        return { classAccess: 'business', roleName: role.name };
      }
    }
    for (const role of userRoles) {
      const n = role.name.toLowerCase();
      if (n.includes('economy')) {
        return { classAccess: 'economy', roleName: role.name };
      }
    }
    return { classAccess: 'economy', roleName: 'Economy' };
  } catch (err) {
    console.warn('Role fetch failed:', err.response?.status, err.message);
    return { classAccess: 'economy', roleName: 'Economy' };
  }
}

/* ─────────────────────────────────────────
   AUTH MIDDLEWARE
───────────────────────────────────────── */
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1] || req.cookies?.ek_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
};

/* ─────────────────────────────────────────
   DISCORD OAUTH
───────────────────────────────────────── */
app.get('/auth/discord', (req, res) => {
  const scopes = ['identify', 'guilds.members.read'].join(' ');
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         scopes
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  const frontend  = process.env.FRONTEND_URL || '/';
  if (!code) return res.redirect(`${frontend}?error=no_code`);

  try {
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  process.env.DISCORD_REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenRes.data;
    const [userRes, roleData] = await Promise.all([
      axios.get('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${access_token}` }
      }),
      resolveClassAccess(access_token)
    ]);
    const discord = userRes.data;

    // Bot rewards: _id = discordId string
    const rewards = await db.collection('rewards').findOne({ _id: discord.id });
    const tier    = rewards?.tier || 'Blue';

    const token = jwt.sign({
      discordId:   discord.id,
      username:    discord.username,
      avatar:      discord.avatar,
      tier,
      classAccess: roleData.classAccess,
      roleName:    roleData.roleName
    }, JWT, { expiresIn: '7d' });

    res.redirect(`${frontend}?token=${token}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect(`${frontend}?error=auth_failed`);
  }
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie('ek_token');
  res.json({ message: 'Logged out' });
});

/* ─────────────────────────────────────────
   /api/me
───────────────────────────────────────── */
app.get('/api/me', auth, async (req, res) => {
  try {
    const { discordId, username, avatar, classAccess, roleName } = req.user;
    const raw = await db.collection('rewards').findOne({ _id: discordId });
    res.json({
      user: {
        discordId, username, avatar,
        skywardsNumber: `EK${discordId}`.substring(0, 12),
        classAccess:    classAccess || 'economy',
        roleName:       roleName    || 'Economy'
      },
      rewards: normRewards(raw, discordId)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   FLIGHTS
───────────────────────────────────────── */
async function enrichFlights(rawFlights) {
  return Promise.all(rawFlights.map(async f => {
    const seats = await getSeats(f._id.toString());
    return normFlight(f, seats);
  }));
}

app.get('/api/flights/popular', async (req, res) => {
  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const raw = await db.collection('flights')
      .find({ status: { $nin: ['CANCELLED', 'COMPLETED'] }, time: { $gte: nowUnix } })
      .sort({ time: 1 }).limit(10).toArray();
    res.json(await enrichFlights(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flights', async (req, res) => {
  try {
    const { origin, destination, date } = req.query;
    const nowUnix = Math.floor(Date.now() / 1000);
    const query   = { status: { $nin: ['CANCELLED', 'COMPLETED'] }, time: { $gte: nowUnix } };
    if (origin)      query.departure = origin.toUpperCase();
    if (destination) query.arrival   = destination.toUpperCase();
    if (date) {
      const d = new Date(date), dEnd = new Date(date);
      dEnd.setDate(dEnd.getDate() + 1);
      query.time = { $gte: Math.floor(d / 1000), $lt: Math.floor(dEnd / 1000) };
    }
    const raw = await db.collection('flights').find(query).sort({ time: 1 }).limit(30).toArray();
    res.json(await enrichFlights(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flights/:id', async (req, res) => {
  try {
    let f;
    try       { f = await db.collection('flights').findOne({ _id: new ObjectId(req.params.id) }); }
    catch (_) { f = await db.collection('flights').findOne({ _id: req.params.id }); }
    if (!f) return res.status(404).json({ error: 'Flight not found' });
    const seats = await getSeats(f._id.toString());
    res.json(normFlight(f, seats));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flights/:id/seats', async (req, res) => {
  try {
    const flightId = req.params.id;
    // Find all non-cancelled bookings for this flight by fnum
    let rawFlight;
    try       { rawFlight = await db.collection('flights').findOne({ _id: new ObjectId(flightId) }); }
    catch (_) { rawFlight = await db.collection('flights').findOne({ _id: flightId }); }
    if (!rawFlight) return res.json({ economy: [], business: [], first: [] });

    const fnum = rawFlight.fnum;
    const bookings = await db.collection('bookings')
      .find({ fnum: { $regex: fnum.split('/')[0].trim(), $options: 'i' }, status: { $ne: 'cancelled' } })
      .toArray();

    const taken = { economy: [], business: [], first: [] };
    for (const b of bookings) {
      if (b.seat) {
        const cls = (b.class || 'Economy').toLowerCase();
        if (taken[cls]) taken[cls].push(b.seat);
      }
    }
    res.json(taken);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/bookings', auth, async (req, res) => {
  try {
    const raw    = await db.collection('bookings').find({ discordId: req.user.discordId }).sort({ bookedAt: -1 }).toArray();
    const normed = await Promise.all(raw.map(normBooking));
    res.json(normed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bookings', auth, async (req, res) => {
  try {
    const { flightId, class: cabinClass, robloxUser, seatNumbers } = req.body;
    if (!flightId || !cabinClass || !robloxUser?.trim())
      return res.status(400).json({ error: 'Missing required fields' });

    let rawFlight;
    try       { rawFlight = await db.collection('flights').findOne({ _id: new ObjectId(flightId) }); }
    catch (_) { rawFlight = await db.collection('flights').findOne({ _id: flightId }); }
    if (!rawFlight) return res.status(404).json({ error: 'Flight not found' });

    // Check seat availability
    const seats = await getSeats(rawFlight._id.toString());
    if ((seats[cabinClass] || 0) <= 0) {
      return res.status(409).json({ error: 'No seats available in this class' });
    }

    const flight   = normFlight(rawFlight, seats);
    const miles    = flight.milesEarned[cabinClass] || 0;
    const price    = flight.classes[cabinClass]?.price || 0;
    const pnr      = `${rawFlight.fnum}-${Math.random().toString(36).substr(2,6).toUpperCase()}`;
    const seat     = seatNumbers?.[0] || null;

    // Write booking in bot-compatible format
    await db.collection('bookings').insertOne({
      code:       pnr,
      fnum:       rawFlight.fnum,
      class:      cabinClass.charAt(0).toUpperCase() + cabinClass.slice(1),
      discordId:  req.user.discordId,
      robloxUser: robloxUser.trim(),
      checkedIn:  false,
      seat,
      price,
      status:     'confirmed',
      bookedAt:   new Date(),
      createdAt:  new Date(),
      updatedAt:  new Date()
    });

    // Decrement available seats by 1
    await db.collection('flightSeats').updateOne(
      { flightId: rawFlight._id.toString() },
      { $inc: { [cabinClass]: -1 } },
      { upsert: true }
    );

    res.status(201).json({
      pnr,
      milesEarned:   miles,
      price,
      seatNumbers:   seat ? [seat] : [],
      flightNumber:  rawFlight.fnum,
      origin:        rawFlight.departure,
      destination:   rawFlight.arrival,
      departureTime: new Date(rawFlight.time * 1000)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/bookings/:id/cancel', auth, async (req, res) => {
  try {
    let oid;
    try { oid = new ObjectId(req.params.id); } catch { oid = req.params.id; }
    const booking = await db.collection('bookings').findOne({ _id: oid, discordId: req.user.discordId });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    await db.collection('bookings').updateOne({ _id: oid }, { $set: { status: 'cancelled', updatedAt: new Date() } });
    res.json({ message: 'Booking cancelled' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   REWARDS
───────────────────────────────────────── */
app.get('/api/rewards', auth, async (req, res) => {
  try {
    const raw = await db.collection('rewards').findOne({ _id: req.user.discordId });
    res.json(normRewards(raw, req.user.discordId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   CATCH-ALL
───────────────────────────────────────── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✈️  Emirates API running on port ${PORT}`));
