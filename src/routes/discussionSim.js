const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;

function extractTextBlock(response) {
  return (response.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
}

function safeJsonParse(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Claude returned empty response");
  }

  let cleaned = text.trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start >= 0 && end > start) {
    const possibleJson = cleaned.slice(start, end + 1);
    return JSON.parse(possibleJson);
  }

  return {
    reply: cleaned,
    recommended_outcome: "manager_review",
    should_stop: true,
    manager_review: true,
    identity_verified: false,
    compliance_flags: ["NON_JSON_MODEL_RESPONSE"],
    notes: "Claude did not return valid JSON. Routed to manager review as a safe fallback."
  };
}

// POST /api/discussion-sim/reply
router.post('/reply', async (req, res) => {
  try {
    const { debt_id, debtor_message, conversation } = req.body;

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: 'ANTHROPIC_API_KEY is missing in .env'
      });
    }

    if (!debt_id) {
      return res.status(400).json({ error: 'debt_id is required' });
    }

    if (!debtor_message) {
      return res.status(400).json({ error: 'debtor_message is required' });
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

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

    const safeConversation = Array.isArray(conversation)
      ? conversation
          .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .slice(-12)
      : [];

    const messages = [
      ...safeConversation,
      {
        role: 'user',
        content: debtor_message
      }
    ];

    const systemPrompt = `
You are Recova's AI debt collection conversation simulator.

This is a TEST SIMULATION only.
No real call is being made.
You are speaking as the AI collection agent.

Debtor:
- Name: ${debtor.full_name}
- Phone: ${debtor.phone_mobile}
- Language: ${debtor.language_preference || 'en'}

Debt:
- Reference: ${debt.reference_number}
- Type: ${debt.debt_type}
- Balance: ZAR ${debt.current_balance}
- Status: ${debt.status}

Hard rules:
1. Be calm, respectful, concise and professional.
2. Do not threaten arrest.
3. Do not imply criminal consequences.
4. Do not harass, shame, insult, pressure, or intimidate.
5. Do not contact family, employer, or third parties.
6. Before identity is reasonably confirmed, do NOT disclose the reference number, balance, creditor, private account details, or address the person by the debtor name as if identity is confirmed.
7. If the person says this is the wrong number, or gives a different name from the debtor, stop collection discussion and recommend wrong_number. Do not reveal who you are looking for. Do not reveal the debtor name. Do not reveal any phone number digits.
8. If the person disputes the debt, stop collection discussion and recommend dispute_raised. If identity is not verified, do not use the debtor's name and do not disclose account details.
9. If the debtor says they are under debt review, stop collection discussion and recommend debt_review.
10. If the debtor asks not to be contacted, stop and recommend opted_out.
11. If the debtor is confused, distressed, angry, vulnerable, or asks for a person, recommend manager_review.
12. When should_stop is true, give a short closing sentence only. Do not ask another open-ended question.
13. If the caller asks "who are you looking for" before identity is verified, do not disclose the debtor name. Say you cannot disclose details unless speaking to the correct person.
13. If the caller asks "who are you looking for" before identity is verified, do not disclose the debtor name. Say you cannot disclose details unless speaking to the correct person.
14. Offer only reasonable payment options. Do not invent fees, penalties, threats, or legal consequences.

Allowed recommended_outcome values:
- continue
- no_answer
- promise_to_pay
- dispute_raised
- callback_requested
- wrong_number
- opted_out
- debt_review
- manager_review

Return JSON only. No markdown. No code fences. No explanations outside JSON. The first character must be { and the last character must be }.

JSON shape:
{
  "reply": "what the AI agent should say next",
  "recommended_outcome": "continue",
  "should_stop": false,
  "manager_review": false,
  "identity_verified": false,
  "compliance_flags": [],
  "notes": "short internal note"
}
`;

    const response = await anthropic.messages.create({
      model,
      max_tokens: 700,
      system: systemPrompt,
      messages
    });

    const rawText = extractTextBlock(response);
    const parsed = safeJsonParse(rawText);

    res.json({
      success: true,
      model,
      debtor: {
        id: debtor.id,
        full_name: debtor.full_name,
        phone_mobile: debtor.phone_mobile
      },
      debt: {
        id: debt.id,
        reference_number: debt.reference_number,
        current_balance: debt.current_balance,
        status: debt.status
      },
      input: debtor_message,
      ai: parsed,
      raw: rawText
    });

  } catch (err) {
    console.error('[DISCUSSION SIM ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;



