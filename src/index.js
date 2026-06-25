require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fileUpload = require('express-fileupload');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 },
  useTempFiles: true,
  tempFileDir: path.join(__dirname, '../uploads/temp'),
  abortOnLimit: true,
  createParentPath: true
}));

// Dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// API routes
app.use('/api/upload', require('./routes/upload'));
app.use('/api/tenants', require('./routes/tenants'));
app.use('/api/debtors', require('./routes/debtors'));
app.use('/api/debts', require('./routes/debts'));
app.use('/api/call-queue', require('./routes/callQueue'));
app.use('/api/agent', require('./routes/agent'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/calls', require('./routes/calls'));
app.use('/api/discussion-sim', require('./routes/discussionSim'));
app.use('/api/twilio', require('./routes/twilioTest'));
app.use('/api/health', require('./routes/health'));

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log('');
  console.log(`RECOVA Backend running on http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
});

module.exports = app;






