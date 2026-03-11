require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");
const Database = require("better-sqlite3");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// DB
const db = new Database("subs.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    client_id TEXT PRIMARY KEY,
    customer_id TEXT,
    subscription_id TEXT,
    status TEXT,
    updated_at TEXT
  )
`);

app.use("/create-checkout-session", express.json());
app.use("/subscription-status", express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: "Missing clientId" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.PRICE_ID, quantity: 1 }],
      client_reference_id: clientId,
      success_url: "parksmart://payment/success",
      cancel_url: "parksmart://payment/cancel"
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook endpoint
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const upsert = db.prepare(`
    INSERT INTO subscriptions (client_id, customer_id, subscription_id, status, updated_at)
    VALUES (@client_id, @customer_id, @subscription_id, @status, datetime('now'))
    ON CONFLICT(client_id) DO UPDATE SET
      customer_id=excluded.customer_id,
      subscription_id=excluded.subscription_id,
      status=excluded.status,
      updated_at=datetime('now')
  `);

  const updateBySub = db.prepare(`
    UPDATE subscriptions
    SET status=@status, updated_at=datetime('now')
    WHERE subscription_id=@subscription_id
  `);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      upsert.run({
        client_id: session.client_reference_id,
        customer_id: session.customer,
        subscription_id: session.subscription,
        status: "active"
      });
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object;
      updateBySub.run({ subscription_id: sub.id, status: sub.status });
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object;
      updateBySub.run({ subscription_id: inv.subscription, status: "past_due" });
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      updateBySub.run({ subscription_id: sub.id, status: "inactive" });
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
});

// Status
app.get("/subscription-status", (req, res) => {
  const clientId = req.query.clientId;
  if (!clientId) return res.status(400).json({ status: "unknown" });

  const row = db.prepare(`SELECT status FROM subscriptions WHERE client_id = ?`).get(clientId);
  res.json({ status: row?.status ?? "inactive" });
});

app.listen(4242, () => console.log("Stripe backend on :4242"));
