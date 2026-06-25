const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET /api/call-queue?tenant_id=xxx
router.get('/', async (req, res) => {
  try {
    const { tenant_id, limit } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const maxRows = Math.min(parseInt(limit || '50', 10), 200);

    const { data: debts, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('status', 'new')
      .eq('is_prescribed', false)
      .order('priority_score', { ascending: false })
      .limit(maxRows);

    if (debtError) {
      return res.status(500).json({ error: debtError.message });
    }

    if (!debts || debts.length === 0) {
      return res.json([]);
    }

    const debtorIds = [...new Set(debts.map(d => d.debtor_id).filter(Boolean))];

    const { data: debtors, error: debtorError } = await supabase
      .from('debtors')
      .select('id, first_name, last_name, full_name, phone_mobile, email, language_preference, debt_review_flag, dispute_flag, do_not_contact, opted_out, preferred_contact_method, best_channel')
      .in('id', debtorIds);

    if (debtorError) {
      return res.status(500).json({ error: debtorError.message });
    }

    const debtorMap = new Map((debtors || []).map(d => [d.id, d]));

    const callQueue = debts
      .map(debt => {
        const debtor = debtorMap.get(debt.debtor_id);

        if (!debtor) return null;

        const blockedReasons = [];

        if (debtor.debt_review_flag) blockedReasons.push('DEBT_REVIEW');
        if (debtor.dispute_flag) blockedReasons.push('DISPUTED');
        if (debtor.do_not_contact) blockedReasons.push('DO_NOT_CONTACT');
        if (debtor.opted_out) blockedReasons.push('OPTED_OUT');
        if (debt.is_prescribed) blockedReasons.push('PRESCRIBED');

        return {
          debt_id: debt.id,
          debtor_id: debtor.id,
          debtor_name: debtor.full_name,
          phone_mobile: debtor.phone_mobile,
          email: debtor.email,
          language_preference: debtor.language_preference,
          reference_number: debt.reference_number,
          debt_type: debt.debt_type,
          current_balance: debt.current_balance,
          priority_score: debt.priority_score,
          status: debt.status,
          contactable: blockedReasons.length === 0,
          blocked_reasons: blockedReasons,
          suggested_channel: debtor.best_channel || debtor.preferred_contact_method || 'voice'
        };
      })
      .filter(Boolean)
      .filter(item => item.contactable);

    res.json(callQueue);

  } catch (err) {
    console.error('[CALL QUEUE ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;

