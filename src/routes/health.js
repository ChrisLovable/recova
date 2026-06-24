const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

router.get('/', async (req, res) => {
  try {
    const { count } = await supabase.from('tenants').select('*', { count: 'exact', head: true });
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      supabase: 'connected',
      tenants: count
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
