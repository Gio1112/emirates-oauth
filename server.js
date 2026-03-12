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
   NORMALIZERS — map bot schema → frontend
───────────────────────────────────────── */

// Bot flight fields: fnum, departure, arrival, time (unix secs), skywardsMiles, status (UPPERCASE), aircraft
function normFlight(f) {
  if (!f) return null;
  const miles = f.skywardsMiles || 1000;
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
    classes: {
      economy:  { price: 0, availableSeats: 80, totalSeats: 200 },
      business: { price: 0, availableSeats: 20, totalSeats: 42  },
      first:    { price: 0, availableSeats: 8,  totalSeats: 14  }
    },
    milesEarned: {
      economy:  Math.round(miles * 0.5),
      business: Math.round(miles * 0.8),
      first:    miles
    }
  };
}

// Bot rewards: _id = discordId string, miles, lifetimeMiles, tier, flightsCompleted
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

// Bot booking fields: code (PNR), fnum, class (capitalised), discordId, checkedIn, robloxUser
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
    status:          b.checkedIn ? 'checked-in' : 'confirmed',
    origin:          flight?.departure || '—',
    originCity:      flight?.departure || '—',
    destination:     flight?.arrival   || '—',
    destinationCity: flight?.arrival   || '—',
    departureTime:   flight ? new Date(flight.time * 1000) : (b.bookedAt || new Date()),
    aircraft:        flight?.aircraft  || '—',
    milesEarned:     flight?.skywardsMiles || 0,
    price:           0,
    passengers:      b.robloxUser ? [{ firstName: b.robloxUser, lastName: '' }] : [],
    seatNumbers:     b.seat ? [b.seat] : [],
    bookedAt:        b.bookedAt || b.createdAt || new Date()
  };
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
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify'
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
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const discord = userRes.data;

    // Bot stores rewards with _id = discordId string
    const rewards = await db.collection('rewards').findOne({ _id: discord.id });
    const tier    = rewards?.tier || 'Blue';

    const token = jwt.sign({
      discordId: discord.id,
      username:  discord.username,
      avatar:    discord.avatar,
      tier
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
   USER — /api/me
───────────────────────────────────────── */
app.get('/api/me', auth, async (req, res) => {
  try {
    const { discordId, username, avatar } = req.user;
    // Bot rewards: _id = discordId string (NOT an ObjectId)
    const raw = await db.collection('rewards').findOne({ _id: discordId });
    res.json({
      user: { discordId, username, avatar, skywardsNumber: `EK${discordId}`.substring(0, 12) },
      rewards: normRewards(raw, discordId)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   FLIGHTS
───────────────────────────────────────── */
app.get('/api/flights/popular', async (req, res) => {
  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const flights = await db.collection('flights')
      .find({ status: { $nin: ['CANCELLED', 'COMPLETED'] }, time: { $gte: nowUnix } })
      .sort({ time: 1 })
      .limit(10)
      .toArray();
    res.json(flights.map(normFlight));
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
    const flights = await db.collection('flights').find(query).sort({ time: 1 }).limit(30).toArray();
    res.json(flights.map(normFlight));
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
    res.json(normFlight(f));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   BOOKINGS
───────────────────────────────────────── */
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
    const { flightId, class: cabinClass, passengers, seatNumbers } = req.body;
    if (!flightId || !cabinClass || !passengers?.length)
      return res.status(400).json({ error: 'Missing required fields' });

    let rawFlight;
    try       { rawFlight = await db.collection('flights').findOne({ _id: new ObjectId(flightId) }); }
    catch (_) { rawFlight = await db.collection('flights').findOne({ _id: flightId }); }
    if (!rawFlight) return res.status(404).json({ error: 'Flight not found' });

    const flight    = normFlight(rawFlight);
    const miles     = flight.milesEarned[cabinClass] || 0;
    const paxName   = `${passengers[0]?.firstName || ''} ${passengers[0]?.lastName || ''}`.trim();
    const pnr       = `${rawFlight.fnum}-${Math.random().toString(36).substr(2,6).toUpperCase()}`;
    const seat      = seatNumbers?.[0] || null;

    // Write in bot-compatible format
    await db.collection('bookings').insertOne({
      code:       pnr,
      fnum:       rawFlight.fnum,
      class:      cabinClass.charAt(0).toUpperCase() + cabinClass.slice(1),
      discordId:  req.user.discordId,
      robloxUser: paxName,
      checkedIn:  false,
      seat,
      passengers,
      bookedAt:   new Date(),
      createdAt:  new Date(),
      updatedAt:  new Date()
    });

    res.status(201).json({
      pnr,
      milesEarned:   miles,
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
   REWARDS — /api/rewards
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
