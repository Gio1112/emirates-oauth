require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
   MONGODB CONNECTION
───────────────────────────────────────── */
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

/* ─────────────────────────────────────────
   SCHEMAS & MODELS
───────────────────────────────────────── */
const flightSchema = new mongoose.Schema({
  flightNumber: { type: String, required: true },
  origin: String,
  originCity: String,
  destination: String,
  destinationCity: String,
  departureTime: Date,
  arrivalTime: Date,
  aircraft: String,
  duration: String,
  status: { type: String, default: 'scheduled' }, // scheduled, boarding, departed, landed, cancelled
  classes: {
    economy: { price: Number, availableSeats: Number, totalSeats: Number },
    business: { price: Number, availableSeats: Number, totalSeats: Number },
    first:    { price: Number, availableSeats: Number, totalSeats: Number }
  },
  milesEarned: { economy: Number, business: Number, first: Number }
}, { collection: 'flights' });

const bookingSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  flightId: { type: mongoose.Schema.Types.ObjectId, ref: 'Flight' },
  flightNumber: String,
  pnr: { type: String, unique: true },
  class: String,
  passengers: [{
    firstName: String,
    lastName: String,
    dateOfBirth: String,
    passportNumber: String,
    nationality: String
  }],
  price: Number,
  status: { type: String, default: 'confirmed' }, // confirmed, cancelled, checked-in, completed
  milesEarned: Number,
  seatNumbers: [String],
  origin: String,
  originCity: String,
  destination: String,
  destinationCity: String,
  departureTime: Date,
  arrivalTime: Date,
  aircraft: String,
  duration: String,
  bookedAt: { type: Date, default: Date.now }
}, { collection: 'bookings' });

const rewardSchema = new mongoose.Schema({
  discordId: { type: String, required: true, unique: true },
  skywardsNumber: String,
  tier: { type: String, default: 'Blue' }, // Blue, Silver, Gold, Platinum
  totalMilesEarned: { type: Number, default: 0 },
  availableMiles: { type: Number, default: 0 },
  transactions: [{
    type: { type: String }, // earned, redeemed, bonus, cancelled
    miles: Number,
    description: String,
    date: { type: Date, default: Date.now },
    flightNumber: String,
    pnr: String
  }],
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'rewards' });

const Flight  = mongoose.model('Flight', flightSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const Reward  = mongoose.model('Reward', rewardSchema);

/* ─────────────────────────────────────────
   AUTH MIDDLEWARE
───────────────────────────────────────── */
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1] || req.cookies?.ek_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'emirates_secret_2024');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/* ─────────────────────────────────────────
   DISCORD OAUTH ROUTES
───────────────────────────────────────── */
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify email'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  const frontend = process.env.FRONTEND_URL || '/';

  if (!code) return res.redirect(`${frontend}?error=no_code`);

  try {
    // Exchange code for access token
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

    // Fetch Discord user info
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const discord = userRes.data;

    // Find or create user in botconfigs collection
    const db = mongoose.connection.db;
    let user = await db.collection('botconfigs').findOne({ discordId: discord.id });

    if (!user) {
      const skywardsNumber = `EK${Math.floor(100000000 + Math.random() * 900000000)}`;
      user = {
        discordId:      discord.id,
        username:       discord.username,
        discriminator:  discord.discriminator || '0',
        avatar:         discord.avatar,
        email:          discord.email || null,
        skywardsNumber,
        tier:           'Blue',
        createdAt:      new Date()
      };
      await db.collection('botconfigs').insertOne(user);

      // Seed rewards record
      await Reward.create({
        discordId:       discord.id,
        skywardsNumber,
        tier:            'Blue',
        totalMilesEarned: 0,
        availableMiles:  0,
        transactions:    [{
          type:        'bonus',
          miles:       500,
          description: 'Welcome to Emirates Skywards!',
          date:        new Date()
        }]
      });
      // Give welcome bonus
      await Reward.findOneAndUpdate({ discordId: discord.id }, {
        $inc: { totalMilesEarned: 500, availableMiles: 500 }
      });
    }

    // Ensure rewards record exists
    let reward = await Reward.findOne({ discordId: discord.id });
    if (!reward) {
      reward = await Reward.create({ discordId: discord.id, skywardsNumber: user.skywardsNumber });
    }

    // Issue JWT
    const jwtToken = jwt.sign({
      discordId:      discord.id,
      username:       discord.username,
      avatar:         discord.avatar,
      skywardsNumber: user.skywardsNumber,
      tier:           user.tier || 'Blue'
    }, process.env.JWT_SECRET || 'emirates_secret_2024', { expiresIn: '7d' });

    res.redirect(`${frontend}?token=${jwtToken}`);
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
   USER ROUTES
───────────────────────────────────────── */
app.get('/api/me', authenticate, async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const user    = await db.collection('botconfigs').findOne({ discordId: req.user.discordId });
    const rewards = await Reward.findOne({ discordId: req.user.discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user, rewards });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   FLIGHT ROUTES
───────────────────────────────────────── */
app.get('/api/flights', async (req, res) => {
  try {
    const { origin, destination, date, class: cabinClass } = req.query;
    const query = { status: { $ne: 'cancelled' }, departureTime: { $gte: new Date() } };

    if (origin)      query.origin      = origin.toUpperCase();
    if (destination) query.destination = destination.toUpperCase();
    if (date) {
      const d   = new Date(date);
      const end = new Date(date);
      end.setDate(end.getDate() + 1);
      query.departureTime = { $gte: d, $lt: end };
    }

    const flights = await Flight.find(query).sort({ departureTime: 1 }).limit(30);
    res.json(flights);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flights/popular', async (req, res) => {
  try {
    const flights = await Flight.find({
      status: { $ne: 'cancelled' },
      departureTime: { $gte: new Date() }
    }).sort({ departureTime: 1 }).limit(6);
    res.json(flights);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flights/:id', async (req, res) => {
  try {
    const flight = await Flight.findById(req.params.id);
    if (!flight) return res.status(404).json({ error: 'Flight not found' });
    res.json(flight);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   BOOKING ROUTES
───────────────────────────────────────── */
app.post('/api/bookings', authenticate, async (req, res) => {
  try {
    const { flightId, class: cabinClass, passengers } = req.body;

    if (!flightId || !cabinClass || !passengers?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const flight = await Flight.findById(flightId);
    if (!flight) return res.status(404).json({ error: 'Flight not found' });

    const classData = flight.classes[cabinClass];
    if (!classData) return res.status(400).json({ error: 'Invalid cabin class' });
    if (classData.availableSeats < passengers.length) {
      return res.status(409).json({ error: 'Insufficient seats available' });
    }

    // Generate PNR (6-char alphanumeric)
    const pnr = (Math.random().toString(36).substr(2, 6)).toUpperCase();

    // Generate seat numbers
    const rowStart = cabinClass === 'first' ? 1 : cabinClass === 'business' ? 8 : 20;
    const cols = ['A','B','C','D','E','F'];
    const seatNumbers = passengers.map((_, i) => {
      const row = rowStart + Math.floor(i / 6) + Math.floor(Math.random() * 5);
      return `${row}${cols[i % 6]}`;
    });

    const totalPrice = classData.price * passengers.length;
    const totalMiles = (flight.milesEarned[cabinClass] || 1000) * passengers.length;

    const booking = await Booking.create({
      discordId:      req.user.discordId,
      flightId:       flight._id,
      flightNumber:   flight.flightNumber,
      pnr,
      class:          cabinClass,
      passengers,
      price:          totalPrice,
      milesEarned:    totalMiles,
      seatNumbers,
      origin:         flight.origin,
      originCity:     flight.originCity,
      destination:    flight.destination,
      destinationCity: flight.destinationCity,
      departureTime:  flight.departureTime,
      arrivalTime:    flight.arrivalTime,
      aircraft:       flight.aircraft,
      duration:       flight.duration
    });

    // Decrement available seats
    await Flight.findByIdAndUpdate(flightId, {
      $inc: { [`classes.${cabinClass}.availableSeats`]: -passengers.length }
    });

    // Add miles & transaction
    await Reward.findOneAndUpdate(
      { discordId: req.user.discordId },
      {
        $inc: { totalMilesEarned: totalMiles, availableMiles: totalMiles },
        $push: {
          transactions: {
            type:        'earned',
            miles:       totalMiles,
            description: `${flight.flightNumber} — ${flight.originCity} → ${flight.destinationCity}`,
            flightNumber: flight.flightNumber,
            pnr,
            date:        new Date()
          }
        },
        updatedAt: new Date()
      },
      { upsert: true }
    );

    // Check tier upgrade
    const reward = await Reward.findOne({ discordId: req.user.discordId });
    const miles  = reward?.totalMilesEarned || 0;
    let newTier  = 'Blue';
    if (miles >= 150000) newTier = 'Platinum';
    else if (miles >= 50000) newTier = 'Gold';
    else if (miles >= 25000) newTier = 'Silver';

    if (newTier !== reward?.tier) {
      await Reward.findOneAndUpdate({ discordId: req.user.discordId }, { tier: newTier });
      await mongoose.connection.db.collection('botconfigs').updateOne(
        { discordId: req.user.discordId }, { $set: { tier: newTier } }
      );
    }

    res.status(201).json({ booking, pnr, milesEarned: totalMiles, tier: newTier });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bookings', authenticate, async (req, res) => {
  try {
    const bookings = await Booking.find({ discordId: req.user.discordId }).sort({ bookedAt: -1 });
    res.json(bookings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bookings/:pnr', authenticate, async (req, res) => {
  try {
    const booking = await Booking.findOne({ pnr: req.params.pnr, discordId: req.user.discordId });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json(booking);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/bookings/:id/cancel', authenticate, async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, discordId: req.user.discordId });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });

    booking.status = 'cancelled';
    await booking.save();

    // Restore seats
    await Flight.findByIdAndUpdate(booking.flightId, {
      $inc: { [`classes.${booking.class}.availableSeats`]: booking.passengers.length }
    });

    // Deduct miles
    await Reward.findOneAndUpdate(
      { discordId: req.user.discordId },
      {
        $inc: { availableMiles: -booking.milesEarned },
        $push: {
          transactions: {
            type:        'cancelled',
            miles:       -booking.milesEarned,
            description: `Cancellation — ${booking.pnr}`,
            pnr:         booking.pnr,
            date:        new Date()
          }
        }
      }
    );

    res.json({ message: 'Booking cancelled successfully' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   REWARDS / SKYWARDS ROUTES
───────────────────────────────────────── */
app.get('/api/rewards', authenticate, async (req, res) => {
  try {
    const rewards = await Reward.findOne({ discordId: req.user.discordId });
    res.json(rewards);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



/* ─────────────────────────────────────────
   CATCH-ALL → serve index.html
───────────────────────────────────────── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✈️  Emirates API running on port ${PORT}`);
});
