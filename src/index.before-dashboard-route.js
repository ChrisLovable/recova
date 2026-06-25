require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fileUpload = require('express-fileupload');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// â”€â”€ Middleware â”€â”€
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  useTempFiles: true,
  tempFileDir: path.join(__dirname, '../uploads/temp'),
  abortOnLimit: true,
  createParentPath: true
}));

// â”€â”€ Routes â”€â”€
app.use('/api/upload',    require('./routes/upload'));
app.use('/api/tenants',   require('./routes/tenants'));
app.use('/api/debtors',   require('./routes/debtors'));
app.use('/api/debts',     require('./routes/debts'));
app.use('/api/health',    require('./routes/health'));

// â”€â”€ 404 â”€â”€
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// â”€â”€ Error handler â”€â”€
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n  RECOVA Backend running on http://localhost:${PORT}`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`  Environment: ${process.env.NODE_ENV}\n`);
});

module.exports = app;

