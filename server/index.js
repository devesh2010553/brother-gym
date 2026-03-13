// ════════════════════════════════════════════════════════
//  Brothers Gym Portal — Express Backend
//  DB: MongoDB Atlas  |  SMS: Fast2SMS  |  Live: YouTube
// ════════════════════════════════════════════════════════
require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.get('/portal', (req,res) => res.sendFile(path.join(__dirname,'../public/portal.html')));
app.get('/',       (req,res) => res.sendFile(path.join(__dirname,'../public/index.html')));

// ── Rate limiters ────────────────────────────────────────
const otpLimiter = rateLimit({
  windowMs: 5*60*1000, max: 3,
  keyGenerator: req => {
    const p = String(req.body?.phone||'').replace(/\D/g,'').slice(-10);
    return p.length===10 ? 'otp_'+p : req.ip;
  },
  handler: (req,res) => res.json({success:false,message:'Too many OTP requests. Wait 5 minutes.'})
});
const loginLimiter = rateLimit({
  windowMs: 15*60*1000, max: 20,
  keyGenerator: req => {
    const p = String(req.body?.phone||'').replace(/\D/g,'').slice(-10);
    return p.length===10 ? 'login_'+p : req.ip;
  },
  handler: (req,res) => res.json({success:false,message:'Too many login attempts. Wait 15 minutes.'})
});

// ════════════════════════════════════════════════════════
//  MONGODB
// ════════════════════════════════════════════════════════
let db;
const PLAN_PRICE = {monthly:800, quarterly:2100, annual:7500};
const PLAN_DAYS  = {monthly:30,  quarterly:90,   annual:365};

async function connectDB() {
  let uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('\n❌  MONGO_URI is not set! Add it in Render → Environment.');
    process.exit(1);
  }
  // If separate user/pass provided, build URI safely (handles @ in password)
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass) {
    // Encode password so special chars like @ don't break the URI
    const encodedPass = encodeURIComponent(pass);
    // Replace placeholder host or inject credentials
    // URI format: mongodb+srv://HOST/...
    uri = uri.replace('mongodb+srv://', `mongodb+srv://${encodeURIComponent(user)}:${encodedPass}@`);
  }
  // Log masked URI for debugging
  const maskedUri = uri.replace(/:([^@]+)@/, ':***@');
  console.log('🔌  Connecting to MongoDB:', maskedUri);
  const client = new MongoClient(uri, {serverSelectionTimeoutMS:15000});
  try {
    await client.connect();
  } catch(connErr) {
    console.error('❌  MongoDB connect() failed:', connErr.message);
    console.error('    URI used (masked):', maskedUri);
    throw connErr;
  }
  db = client.db('brothers_gym');
  // indexes
  await db.collection('members').createIndex({phone:1},{unique:true});
  await db.collection('payments').createIndex({memberId:1});
  await db.collection('payments').createIndex({createdAt:-1});
  await db.collection('notifications').createIndex({time:-1});
  console.log('✅  MongoDB Atlas connected — brothers_gym database ready');
  // NO seed data — gym owner adds real members
}

function sanitize(m) {
  if (!m) return null;
  const {password, _id, ...safe} = m;
  return safe;
}

// ════════════════════════════════════════════════════════
//  OTP — Fast2SMS
//  Free plan uses route:'v3' (DLT-free variable route)
//  If that fails, falls back to route:'otp'
// ════════════════════════════════════════════════════════
const otpStore = {};

function generateOTP() {
  return Math.floor(100000 + Math.random()*900000).toString();
}

async function sendSMS(phone, otp) {
  const apiKey = process.env.FAST2SMS_API_KEY;

  // DEV MODE — no API key
  if (!apiKey || apiKey === 'YOUR_FAST2SMS_API_KEY_HERE') {
    console.log('\n══════════════════════════════════════');
    console.log('📱  [DEV MODE] OTP for ' + phone + ' → ' + otp);
    console.log('    Add FAST2SMS_API_KEY in .env for real SMS');
    console.log('══════════════════════════════════════\n');
    return {success:true, devMode:true, otp};
  }

  console.log('📤  Sending OTP ' + otp + ' to ' + phone + ' via Fast2SMS...');

  // ── Attempt 1: route v3 (works on free Fast2SMS accounts) ──
  try {
    const resp = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      params: {
        authorization: apiKey,
        variables_values: otp,
        route: 'otp',
        numbers: phone
      },
      headers: {'cache-control':'no-cache'},
      timeout: 15000
    });
    console.log('Fast2SMS response:', JSON.stringify(resp.data));
    if (resp.data && resp.data.return === true) {
      console.log('✅  SMS sent successfully to ' + phone);
      return {success:true};
    }
    const errMsg = Array.isArray(resp.data?.message) ? resp.data.message[0] : (resp.data?.message || 'SMS failed');
    console.log('OTP route failed:', errMsg, '— trying quick route...');
    return await sendSMSQuickRoute(phone, otp, apiKey);
  } catch(e) {
    console.error('OTP route error:', e.message);
    return await sendSMSQuickRoute(phone, otp, apiKey);
  }
}

// ── Attempt 2: Quick SMS route (paid but try anyway) ──
async function sendSMSQuickRoute(phone, otp, apiKey) {
  try {
    const resp = await axios.post('https://www.fast2sms.com/dev/bulkV2', {
      route: 'q',
      message: 'Your Brothers Gym OTP is ' + otp + '. Valid for 5 minutes. Do not share.',
      language: 'english',
      flash: 0,
      numbers: phone
    }, {
      headers: {
        'authorization': apiKey,
        'Content-Type': 'application/json',
        'cache-control': 'no-cache'
      },
      timeout: 15000
    });
    console.log('Quick route response:', JSON.stringify(resp.data));
    if (resp.data && resp.data.return === true) {
      console.log('✅  SMS sent via quick route to ' + phone);
      return {success:true};
    }
    const errMsg = Array.isArray(resp.data?.message) ? resp.data.message[0] : (resp.data?.message || 'Both SMS routes failed');
    return {success:false, error: errMsg};
  } catch(e) {
    console.error('Quick route error:', e.message);
    if (e.response) console.error('Response:', JSON.stringify(e.response.data));
    return {success:false, error: 'Fast2SMS unreachable. Check your API key or account balance.'};
  }
}

// ── OTP Routes ───────────────────────────────────────────
app.post('/api/otp/send', otpLimiter, async (req,res) => {
  let {phone} = req.body;
  phone = String(phone||'').replace(/\D/g,'').slice(-10);
  if (!phone || phone.length !== 10)
    return res.json({success:false, message:'Enter a valid 10-digit phone number.'});

  const otp = generateOTP();
  otpStore[phone] = {otp, expiresAt: Date.now()+5*60*1000, attempts:0};
  const result = await sendSMS(phone, otp);

  if (!result.success) {
    delete otpStore[phone];
    return res.json({success:false, message: result.error || 'SMS failed. Check Fast2SMS API key.'});
  }
  if (result.devMode) {
    return res.json({success:true, devMode:true, devOtp:otp, message:'[DEV] OTP is: '+otp+' (No API key set)'});
  }
  res.json({success:true, message:'OTP sent to +91'+phone});
});

app.post('/api/otp/verify', (req,res) => {
  let {phone, otp} = req.body;
  phone = String(phone||'').replace(/\D/g,'').slice(-10);
  const stored = otpStore[phone];
  if (!stored) return res.json({success:false, message:'No OTP found. Please request a new one.'});
  if (Date.now() > stored.expiresAt) {
    delete otpStore[phone];
    return res.json({success:false, message:'OTP expired. Request a new one.'});
  }
  stored.attempts++;
  if (stored.attempts > 5) {
    delete otpStore[phone];
    return res.json({success:false, message:'Too many wrong attempts. Request a new OTP.'});
  }
  if (String(stored.otp) !== String(otp||'').trim())
    return res.json({success:false, message:'Wrong OTP. '+(5-stored.attempts)+' attempts left.'});
  delete otpStore[phone];
  res.json({success:true, message:'OTP verified!'});
});

// ════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════
app.post('/api/auth/signup', async (req,res) => {
  const {name, phone, password} = req.body;
  const cp = String(phone||'').replace(/\D/g,'').slice(-10);
  if (!name || !cp || !password) return res.json({success:false, message:'All fields required.'});
  if (password.length < 6) return res.json({success:false, message:'Password must be at least 6 characters.'});
  try {
    const ex = await db.collection('members').findOne({phone:cp});
    if (ex && ex.password) return res.json({success:false, message:'Account already exists. Please login.'});
    if (ex) {
      await db.collection('members').updateOne({phone:cp}, {$set:{password, name}});
      const updated = await db.collection('members').findOne({phone:cp});
      return res.json({success:true, message:'Account activated! Welcome '+name, member:sanitize(updated)});
    }
    // New member signup — pending approval by admin
    const id = 'M' + Date.now().toString().slice(-6);
    const m = {id, name, phone:cp, plan:'monthly', admissionDate:new Date().toISOString().split('T')[0], gender:'', notes:'Signed up via app — pending admin approval', emergency:'', paymentStatus:'pending', password};
    await db.collection('members').insertOne(m);
    res.json({success:true, message:'Account created! Visit gym to activate membership.', member:sanitize(m)});
  } catch(e) {
    console.error('Signup error:', e.message);
    res.json({success:false, message:'Server error. Please try again.'});
  }
});

app.post('/api/auth/login', loginLimiter, async (req,res) => {
  const {phone, password} = req.body;
  const cp = String(phone||'').replace(/\D/g,'').slice(-10);
  try {
    const m = await db.collection('members').findOne({phone:cp, password});
    if (!m) return res.json({success:false, message:'Wrong phone number or password.'});
    res.json({success:true, member:sanitize(m)});
  } catch(e) {
    res.json({success:false, message:'Server error. Please try again.'});
  }
});

app.post('/api/auth/reset-password', async (req,res) => {
  const {phone, password} = req.body;
  const cp = String(phone||'').replace(/\D/g,'').slice(-10);
  if (!password || password.length < 6) return res.json({success:false, message:'Password must be at least 6 characters.'});
  try {
    const r = await db.collection('members').updateOne({phone:cp}, {$set:{password}});
    if (r.matchedCount === 0) return res.json({success:false, message:'No account found with this phone number.'});
    res.json({success:true, message:'Password reset successfully! Please login.'});
  } catch(e) {
    res.json({success:false, message:'Server error.'});
  }
});

app.post('/api/auth/change-password', async (req,res) => {
  const {phone, oldPassword, newPassword} = req.body;
  const cp = String(phone||'').replace(/\D/g,'').slice(-10);
  try {
    const m = await db.collection('members').findOne({phone:cp});
    if (!m) return res.json({success:false, message:'Account not found.'});
    if (m.password !== oldPassword) return res.json({success:false, message:'Current password is incorrect.'});
    if (!newPassword || newPassword.length < 6) return res.json({success:false, message:'New password must be at least 6 characters.'});
    await db.collection('members').updateOne({phone:cp}, {$set:{password:newPassword}});
    res.json({success:true, message:'Password changed successfully!'});
  } catch(e) {
    res.json({success:false, message:'Server error.'});
  }
});

app.post('/api/auth/admin', (req,res) => {
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.body.password !== adminPass) return res.json({success:false, message:'Wrong admin password.'});
  res.json({success:true});
});

// ════════════════════════════════════════════════════════
//  MEMBERS
// ════════════════════════════════════════════════════════
app.get('/api/members', async (req,res) => {
  try {
    const members = await db.collection('members').find({}).sort({admissionDate:-1}).toArray();
    res.json(members.map(sanitize));
  } catch(e) {
    res.json([]);
  }
});

app.post('/api/members', async (req,res) => {
  const {name, phone, plan, admissionDate, gender, emergency, notes, paymentStatus, password} = req.body;
  const cp = String(phone||'').replace(/\D/g,'').slice(-10);
  if (!name || !cp || !plan || !admissionDate)
    return res.json({success:false, message:'Name, phone, plan and date are required.'});

  const assignedPass = (password && password.length >= 6) ? password : 'gym123';
  try {
    const ex = await db.collection('members').findOne({phone:cp});
    if (ex) {
      // Update existing member
      const upd = {plan, admissionDate, paymentStatus: paymentStatus||'pending'};
      if (gender)    upd.gender    = gender;
      if (emergency) upd.emergency = emergency;
      if (notes)     upd.notes     = notes;
      if (password && password.length >= 6) upd.password = password;
      await db.collection('members').updateOne({phone:cp}, {$set:upd});
      await addPayment({memberId:ex.id, memberName:ex.name, phone:cp, plan, amount:PLAN_PRICE[plan]||0, date:admissionDate, status:paymentStatus||'pending'});
      const updated = await db.collection('members').findOne({phone:cp});
      return res.json({success:true, message:ex.name+"'s membership updated.", member:sanitize(updated)});
    }
    // Add new member
    const id = 'M' + Date.now().toString().slice(-6);
    const nm = {id, name, phone:cp, plan, admissionDate, gender:gender||'', emergency:emergency||'', notes:notes||'', paymentStatus:paymentStatus||'pending', password:assignedPass};
    await db.collection('members').insertOne(nm);
    await addPayment({memberId:id, memberName:name, phone:cp, plan, amount:PLAN_PRICE[plan]||0, date:admissionDate, status:paymentStatus||'pending'});
    res.json({success:true, message:name+' added! Login password: '+assignedPass, member:sanitize(nm)});
  } catch(e) {
    console.error('Add member error:', e.message);
    if (e.code === 11000) return res.json({success:false, message:'Phone number already exists.'});
    res.json({success:false, message:'Server error: '+e.message});
  }
});

app.put('/api/members/:id', async (req,res) => {
  try {
    const {_id, password, ...upd} = req.body; // never overwrite password via edit
    await db.collection('members').updateOne({id:req.params.id}, {$set:upd});
    const updated = await db.collection('members').findOne({id:req.params.id});
    res.json({success:true, member:sanitize(updated)});
  } catch(e) {
    res.json({success:false, message:'Update failed.'});
  }
});

app.delete('/api/members/:id', async (req,res) => {
  try {
    await db.collection('members').deleteOne({id:req.params.id});
    res.json({success:true});
  } catch(e) {
    res.json({success:false, message:'Delete failed.'});
  }
});

app.post('/api/members/:id/renew', async (req,res) => {
  const {plan, date, paymentStatus} = req.body;
  try {
    const m = await db.collection('members').findOne({id:req.params.id});
    if (!m) return res.json({success:false, message:'Member not found.'});
    await db.collection('members').updateOne({id:req.params.id}, {$set:{plan, admissionDate:date, paymentStatus}});
    await addPayment({memberId:m.id, memberName:m.name, phone:m.phone, plan, amount:PLAN_PRICE[plan]||0, date, status:paymentStatus});
    await addNotification({type:'success', icon:'✅', title:m.name+' membership renewed', desc:'New plan: '+plan+' from '+date, memberId:m.id});
    const updated = await db.collection('members').findOne({id:req.params.id});
    res.json({success:true, member:sanitize(updated)});
  } catch(e) {
    res.json({success:false, message:'Renewal failed.'});
  }
});

// ════════════════════════════════════════════════════════
//  PAYMENTS
// ════════════════════════════════════════════════════════
async function addPayment(data) {
  await db.collection('payments').insertOne({
    id: 'P'+uuidv4().substr(0,6).toUpperCase(),
    ...data,
    createdAt: new Date().toISOString()
  });
}

app.get('/api/payments', async (req,res) => {
  try {
    const p = await db.collection('payments').find({}).sort({createdAt:-1}).toArray();
    res.json(p.map(({_id,...x}) => x));
  } catch(e) { res.json([]); }
});

app.get('/api/payments/member/:id', async (req,res) => {
  try {
    const p = await db.collection('payments').find({memberId:req.params.id}).sort({createdAt:-1}).toArray();
    res.json(p.map(({_id,...x}) => x));
  } catch(e) { res.json([]); }
});

app.put('/api/payments/:id/mark-paid', async (req,res) => {
  try {
    await db.collection('payments').updateOne({id:req.params.id}, {$set:{status:'paid'}});
    const p = await db.collection('payments').findOne({id:req.params.id});
    if (p) {
      await db.collection('members').updateOne({id:p.memberId}, {$set:{paymentStatus:'paid'}});
      await addNotification({type:'success', icon:'💳', title:'Payment confirmed for '+p.memberName, desc:'₹'+p.amount+' — '+p.plan, memberId:p.memberId});
    }
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

// ════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════
async function addNotification(data) {
  try {
    const count = await db.collection('notifications').countDocuments();
    if (count >= 200) {
      const oldest = await db.collection('notifications').find({}).sort({time:1}).limit(count-199).toArray();
      if (oldest.length) await db.collection('notifications').deleteMany({_id:{$in:oldest.map(n=>n._id)}});
    }
    await db.collection('notifications').insertOne({id:uuidv4(), ...data, read:false, time:new Date().toISOString()});
  } catch(e) { console.error('addNotification error:', e.message); }
}

app.get('/api/notifications', async (req,res) => {
  try {
    const n = await db.collection('notifications').find({}).sort({time:-1}).toArray();
    res.json(n.map(({_id,...x}) => x));
  } catch(e) { res.json([]); }
});

app.post('/api/notifications/check-expiry', async (req,res) => {
  try {
    const members = await db.collection('members').find({}).toArray();
    const today = new Date(); today.setHours(0,0,0,0);
    const todayStr = today.toISOString().split('T')[0];
    let added = 0;
    for (const m of members) {
      const exp = new Date(m.admissionDate);
      exp.setDate(exp.getDate() + (PLAN_DAYS[m.plan]||30));
      const daysLeft = Math.ceil((exp - today) / 86400000);
      const key = 'expiry_'+m.id+'_'+todayStr;
      const exists = await db.collection('notifications').findOne({key});
      if (exists) continue;
      if (daysLeft <= 0) {
        await addNotification({key, type:'danger', icon:'🚨', title:m.name+"'s membership EXPIRED", desc:'Phone: '+m.phone+' — Collect renewal fee', memberId:m.id});
        added++;
      } else if (daysLeft <= 3) {
        await addNotification({key, type:'danger', icon:'⚠️', title:m.name+' — '+daysLeft+' day(s) left!', desc:'Phone: '+m.phone+' — Expiring very soon', memberId:m.id});
        added++;
      } else if (daysLeft <= 7) {
        await addNotification({key, type:'warn', icon:'🔔', title:m.name+' — '+daysLeft+' days left', desc:'Phone: '+m.phone+' — Expiring soon', memberId:m.id});
        added++;
      }
    }
    res.json({success:true, added});
  } catch(e) { res.json({success:false, added:0}); }
});

app.put('/api/notifications/:id/read', async (req,res) => {
  try {
    await db.collection('notifications').updateOne({id:req.params.id}, {$set:{read:true}});
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

app.delete('/api/notifications', async (req,res) => {
  try {
    await db.collection('notifications').deleteMany({});
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

// ════════════════════════════════════════════════════════
//  LIVE STREAM — YouTube/Facebook link based
//  Admin sets a YouTube Live URL, members watch it
//  This works across ALL devices (not just same browser)
// ════════════════════════════════════════════════════════
let liveStatus = {live:false, url:'', startedAt:null, title:'Gym Live Session'};

app.get('/api/live/status', (req,res) => res.json(liveStatus));

app.post('/api/live/start', (req,res) => {
  const {url, title} = req.body;
  liveStatus = {
    live: true,
    url: url || '',
    title: title || 'Gym Live Session',
    startedAt: new Date().toISOString()
  };
  console.log('🔴  Live stream started:', url);
  res.json({success:true, liveStatus});
});

app.post('/api/live/stop', (req,res) => {
  liveStatus = {live:false, url:'', startedAt:null, title:''};
  console.log('⏹   Live stream stopped');
  res.json({success:true});
});

// ════════════════════════════════════════════════════════
//  HEALTH CHECK (UptimeRobot pings /ping every 5 min)
// ════════════════════════════════════════════════════════
app.get('/ping',   (req,res) => res.json({status:'ok', time:new Date().toISOString(), gym:'Brothers Gym Mathura 💪'}));
app.get('/health', (req,res) => res.json({status:'healthy'}));

// ════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════
//  START HTTP FIRST — then connect DB
//  This way Render sees the server is up and we get full logs
// ════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🏋️   Brothers Gym HTTP server started on port ' + PORT);

  // Print all env vars so we can debug in Render logs
  console.log('\n🔍  Environment check:');
  console.log('    MONGO_URI  :', process.env.MONGO_URI
    ? '✅ "' + process.env.MONGO_URI.substring(0, 40) + '..."'
    : '❌ NOT SET');
  console.log('    MONGO_USER :', process.env.MONGO_USER || '❌ NOT SET');
  console.log('    MONGO_PASS :', process.env.MONGO_PASS
    ? '✅ set (length ' + process.env.MONGO_PASS.length + ')'
    : '❌ NOT SET');
  console.log('    ADMIN_PASS :', process.env.ADMIN_PASSWORD ? '✅ set' : '⚠️  using default admin123');
  console.log('    FAST2SMS   :', process.env.FAST2SMS_API_KEY ? '✅ set' : '⚠️  DEV MODE');

  // Now connect to MongoDB
  connectDB()
    .then(() => {
      console.log('\n🎉  All systems go! Server + Database both running.\n');
    })
    .catch(err => {
      console.error('\n❌  MongoDB failed to connect!');
      console.error('    Name   :', err.name);
      console.error('    Message:', err.message);
      console.error('    Fix: Check MONGO_URI, MONGO_USER, MONGO_PASS in Render Environment\n');
      // Keep HTTP server alive — API routes will return errors gracefully
    });
});