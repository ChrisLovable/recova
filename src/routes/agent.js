const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

function money(value) {
  return 'R' + Number(value || 0).toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function roundedInstallment(amount, months) {
  return Math.ceil((Number(amount || 0) / months) / 50) * 50;
}

function buildPaymentOptions(amount) {
  const value = Number(amount || 0);

  return [
    {
      option: 1,
      label: 'Full settlement today',
      amount: value,
      wording: `Settle the full balance of ${money(value)} today.`
    },
    {
      option: 2,
      label: 'Three month arrangement',
      amount: roundedInstallment(value, 3),
      wording: `Pay approximately ${money(roundedInstallment(value, 3))} per month for 3 months.`
    },
    {
      option: 3,
      label: 'Minimum payment today',
      amount: Math.max(100, Math.ceil((value * 0.05) / 50) * 50),
      wording: `Make a minimum payment today and arrange the balance afterwards.`
    }
  ];
}

function complianceCheck(debtor, debt) {
  const blocked = [];

  if (!debtor) blocked.push('NO_DEBTOR_FOUND');
  if (!debt) blocked.push('NO_DEBT_FOUND');

  if (debtor?.debt_review_flag) blocked.push('DEBT_REVIEW');
  if (debtor?.dispute_flag) blocked.push('DISPUTED');
  if (debtor?.do_not_contact) blocked.push('DO_NOT_CONTACT');
  if (debtor?.opted_out) blocked.push('OPTED_OUT');
  if (debt?.is_prescribed) blocked.push('PRESCRIBED');
  if (debt?.status !== 'new') blocked.push('NOT_NEW_STATUS');

  return {
    passed: blocked.length === 0,
    blocked_reasons: blocked
  };
}

function buildScript(debtor, debt) {
  const name = debtor.full_name || `${debtor.first_name || ''} ${debtor.last_name || ''}`.trim() || 'the customer';
  const amount = money(debt.current_balance);
  const reference = debt.reference_number || debt.internal_reference || 'your account';

  const options = buildPaymentOptions(debt.current_balance);

  return {
    phase_1_opening: `Good day, may I speak with ${name}?`,
    phase_2_privacy: `Before I discuss any private account information, I need to confirm I am speaking to the correct person.`,
    phase_3_reason_for_call: `I am calling about an outstanding account, reference ${reference}. The current balance showing is ${amount}.`,
    phase_4_empathy: `I understand that people are under pressure. My goal is not to make this difficult, but to find a workable payment option.`,
    phase_5_options: options.map(o => o.wording),
    phase_6_close: `Which of these options would work best for you today?`,
    phase_7_payment_link: `If you choose an option, I can send a secure payment link by SMS while we are still on the call.`,
    prohibited: [
      'Do not threaten arrest.',
      'Do not imply criminal consequences.',
      'Do not contact family or employer.',
      'Do not continue if debtor says they are under debt review.',
      'Do not continue if debtor disputes the debt.',
      'Do not use harassing language.'
    ]
  };
}

// GET /api/agent/next-call?tenant_id=xxx
router.get('/next-call', async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const { data: debts, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('status', 'new')
      .eq('is_prescribed', false)
      .order('priority_score', { ascending: false })
      .limit(20);

    if (debtError) {
      return res.status(500).json({ error: debtError.message });
    }

    if (!debts || debts.length === 0) {
      return res.json({ message: 'No callable debts found', next_call: null });
    }

    const debtorIds = [...new Set(debts.map(d => d.debtor_id).filter(Boolean))];

    const { data: debtors, error: debtorError } = await supabase
      .from('debtors')
      .select('*')
      .in('id', debtorIds);

    if (debtorError) {
      return res.status(500).json({ error: debtorError.message });
    }

    const debtorMap = new Map((debtors || []).map(d => [d.id, d]));

    for (const debt of debts) {
      const debtor = debtorMap.get(debt.debtor_id);
      const compliance = complianceCheck(debtor, debt);

      if (compliance.passed) {
        return res.json({
          next_call: {
            debtor,
            debt,
            compliance,
            payment_options: buildPaymentOptions(debt.current_balance),
            script: buildScript(debtor, debt)
          }
        });
      }
    }

    res.json({ message: 'No contactable debts found after compliance filtering', next_call: null });

  } catch (err) {
    console.error('[AGENT NEXT CALL ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/agent/script/:debt_id
router.get('/script/:debt_id', async (req, res) => {
  try {
    const { debt_id } = req.params;

    const { data: debt, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .eq('id', debt_id)
      .single();

    if (debtError || !debt) {
      return res.status(404).json({ error: 'Debt not found' });
    }

    const { data: debtor, error: debtorError } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', debt.debtor_id)
      .single();

    if (debtorError || !debtor) {
      return res.status(404).json({ error: 'Debtor not found' });
    }

    const compliance = complianceCheck(debtor, debt);

    res.json({
      debtor,
      debt,
      compliance,
      contactable: compliance.passed,
      payment_options: buildPaymentOptions(debt.current_balance),
      script: compliance.passed ? buildScript(debtor, debt) : null
    });

  } catch (err) {
    console.error('[AGENT SCRIPT ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});


// POST /api/agent/fake-attempt
router.post('/fake-attempt', async (req, res) => {
  try {
    const { debt_id, outcome } = req.body;

    if (!debt_id) {
      return res.status(400).json({ error: 'debt_id is required' });
    }

    const { data: debt, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .eq('id', debt_id)
      .single();

    if (debtError || !debt) {
      return res.status(404).json({ error: 'Debt not found' });
    }

    const { data: debtor, error: debtorError } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', debt.debtor_id)
      .single();

    if (debtorError || !debtor) {
      return res.status(404).json({ error: 'Debtor not found' });
    }

    const compliance = complianceCheck(debtor, debt);

    if (!compliance.passed) {
      return res.status(403).json({
        error: 'Debtor is not contactable',
        blocked_reasons: compliance.blocked_reasons
      });
    }

    const auditPayload = {
      tenant_id: debt.tenant_id,
      action: 'fake_call_attempt_logged',
      entity_type: 'debt',
      entity_id: debt.id,
      new_value: {
        simulated: true,
        twilio_call_made: false,
        debtor_id: debtor.id,
        debtor_name: debtor.full_name,
        phone_mobile: debtor.phone_mobile,
        debt_id: debt.id,
        reference_number: debt.reference_number,
        current_balance: debt.current_balance,
        outcome: outcome || 'preview_logged',
        compliance_passed: compliance.passed,
        blocked_reasons: compliance.blocked_reasons,
        logged_at: new Date().toISOString()
      },
      notes: `Fake call attempt logged for ${debtor.full_name}. No Twilio call was made.`
    };

    const { data: audit, error: auditError } = await supabase
      .from('cfdc_audit_log')
      .insert(auditPayload)
      .select()
      .single();

    if (auditError) {
      return res.status(500).json({
        error: auditError.message,
        hint: 'Could not insert into cfdc_audit_log'
      });
    }

    res.json({
      success: true,
      message: 'Fake call attempt logged. No real call was made.',
      debtor: {
        id: debtor.id,
        full_name: debtor.full_name,
        phone_mobile: debtor.phone_mobile
      },
      debt: {
        id: debt.id,
        reference_number: debt.reference_number,
        current_balance: debt.current_balance
      },
      audit
    });

  } catch (err) {
    console.error('[FAKE ATTEMPT ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;

