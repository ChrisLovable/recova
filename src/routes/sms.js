const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const supabase = require('../utils/supabase');

function getSmsClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials missing in .env');
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function getSmsFrom() {
  return process.env.TWILIO_PHONE_NUMBER;
}

// POST /api/sms/send-dispute-window
// Sends the 24-hour pre-call SMS to all new debtors for a tenant
router.post('/send-dispute-window', async (req, res) => {
  try {
    const { tenant_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

    const { data: tenant } = await supabase
      .from('tenants').select('*').eq('id', tenant_id).single();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { data: debts, error: debtError } = await supabase
      .from('debts')
      .select('*, debtors(*)')
      .eq('tenant_id', tenant_id)
      .eq('status', 'new');

    if (debtError) return res.status(500).json({ error: debtError.message });
    if (!debts || debts.length === 0) return res.json({ message: 'No new debts to notify', sent: 0 });

    const client = getSmsClient();
    const from = getSmsFrom();
    const results = [];

    for (const debt of debts) {
      const debtor = debt.debtors;
      if (!debtor || !debtor.phone_mobile) {
        results.push({ debt_id: debt.id, status: 'skipped', reason: 'No phone number' });
        continue;
      }

      if (debtor.do_not_contact || debtor.opted_out || debtor.debt_review_flag) {
        results.push({ debt_id: debt.id, status: 'skipped', reason: 'Do not contact flag' });
        continue;
      }

      const creditorName = tenant.company_name || 'a creditor';
      const amount = `R${Number(debt.current_balance).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
      const reference = debt.reference_number || debt.internal_reference;

      const message = `${creditorName} has listed an outstanding account (ref: ${reference}) for ${amount}. ` +
        `If you dispute this, reply DISPUTE within 24 hours and no calls will be made. ` +
        `To stop all contact reply STOP. Recova AI Collections.`;

      try {
        const sms = await client.messages.create({
          to: `+${debtor.phone_mobile.replace(/^\+/, '')}`,
          from,
          body: message
        });

        await supabase.from('sms_log').insert({
          tenant_id,
          debtor_id: debtor.id,
          debt_id: debt.id,
          twilio_message_sid: sms.sid,
          direction: 'outbound',
          to_number: debtor.phone_mobile,
          from_number: from,
          message_body: message,
          message_type: 'dispute_window',
          status: 'sent',
          sent_at: new Date().toISOString()
        });

        await supabase.from('cfdc_audit_log').insert({
          tenant_id,
          action: 'dispute_window_sms_sent',
          entity_type: 'debt',
          entity_id: debt.id,
          new_value: { sms_sid: sms.sid, to: debtor.phone_mobile, message },
          notes: `24-hour dispute window SMS sent to ${debtor.full_name}`
        });

        results.push({ debt_id: debt.id, debtor: debtor.full_name, status: 'sent', sms_sid: sms.sid });

      } catch (smsErr) {
        results.push({ debt_id: debt.id, debtor: debtor.full_name, status: 'failed', error: smsErr.message });
      }
    }

    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const skipped = results.filter(r => r.status === 'skipped').length;

    res.json({ success: true, sent, failed, skipped, results });

  } catch (err) {
    console.error('[DISPUTE WINDOW ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// POST /api/sms/inbound — Twilio webhook for incoming SMS
router.post('/inbound', async (req, res) => {
  try {
    const from = req.body.From;
    const body = (req.body.Body || '').trim().toUpperCase();
    const to = req.body.To;

    console.log(`[INBOUND SMS] From: ${from} | Body: ${body}`);

    const normalised = from.replace(/^\+/, '');

    const { data: debtor } = await supabase
      .from('debtors')
      .select('*')
      .eq('phone_mobile', normalised)
      .single();

    if (!debtor) {
      console.log(`[INBOUND SMS] No debtor found for ${from}`);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
      return res.type('text/xml').send(twiml);
    }

    const now = new Date().toISOString();

    await supabase.from('sms_log').insert({
      tenant_id: debtor.tenant_id,
      debtor_id: debtor.id,
      direction: 'inbound',
      to_number: to,
      from_number: from,
      message_body: req.body.Body,
      message_type: body.startsWith('DISPUTE') ? 'dispute' : body === 'STOP' ? 'opt_out' : 'inbound',
      status: 'received',
      sent_at: now
    });

    if (body === 'STOP' || body.startsWith('STOP')) {
      await supabase.from('debtors').update({
        opted_out: true,
        opted_out_at: now,
        do_not_contact: true,
        do_not_contact_reason: 'Debtor replied STOP via SMS',
        do_not_contact_at: now
      }).eq('id', debtor.id);

      await supabase.from('do_not_contact_register').upsert({
        tenant_id: debtor.tenant_id,
        debtor_id: debtor.id,
        reason: 'Debtor replied STOP via SMS',
        requested_via: 'sms',
        registered_at: now,
        registered_by: 'system'
      }, { onConflict: 'tenant_id,debtor_id' });

      await supabase.from('cfdc_audit_log').insert({
        tenant_id: debtor.tenant_id,
        action: 'debtor_opted_out_sms',
        entity_type: 'debtor',
        entity_id: debtor.id,
        new_value: { opted_out: true, via: 'sms_stop', at: now },
        notes: `Debtor ${debtor.full_name} replied STOP. Opted out immediately.`
      });

      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>You have been removed from our contact list. No further messages or calls will be made. Recova AI Collections.</Message></Response>`;
      return res.type('text/xml').send(twiml);
    }

    if (body.startsWith('DISPUTE')) {
      await supabase.from('debtors').update({
        dispute_flag: true,
        dispute_reason: 'Debtor disputed via SMS',
        dispute_raised_at: now
      }).eq('id', debtor.id);

      await supabase.from('debts').update({
        status: 'disputed',
        escalation_level: 'supervisor'
      }).eq('debtor_id', debtor.id).eq('status', 'new');

      await supabase.from('dispute_register').insert({
        tenant_id: debtor.tenant_id,
        debtor_id: debtor.id,
        dispute_reason: 'Debtor replied DISPUTE via SMS',
        raised_at: now,
        raised_via: 'sms',
        status: 'open'
      });

      await supabase.from('cfdc_audit_log').insert({
        tenant_id: debtor.tenant_id,
        action: 'dispute_raised_sms',
        entity_type: 'debtor',
        entity_id: debtor.id,
        new_value: { dispute_flag: true, via: 'sms_dispute', at: now },
        notes: `Debtor ${debtor.full_name} replied DISPUTE. All calls paused.`
      });

      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>Your dispute has been recorded. All collection calls are paused pending review. Reference your account with us for follow-up. Recova AI Collections.</Message></Response>`;
      return res.type('text/xml').send(twiml);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
    res.type('text/xml').send(twiml);

  } catch (err) {
    console.error('[INBOUND SMS ERROR]', err);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
    res.type('text/xml').send(twiml);
  }
});

// GET /api/sms/log?tenant_id=xxx
router.get('/log', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id required' });

    const { data, error } = await supabase
      .from('sms_log')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
