import Stripe from 'stripe';
import { supabase } from '../../db/supabase.js';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' })
  : null;

export default async function billingRoutes(app) {

  // ─── Get subscription status ───────────────────────────────────────────
  app.get('/status', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { data: user } = await supabase
      .from('users')
      .select('plan, stripe_subscription_id, plan_expires_at')
      .eq('id', req.user.sub)
      .single();

    return reply.send({
      plan: user.plan,
      expiresAt: user.plan_expires_at,
      features: getPlanFeatures(user.plan),
    });
  });

  // ─── Create checkout session ───────────────────────────────────────────
  app.post('/checkout', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!stripe) {
      return reply.code(503).send({ error: 'Billing not configured' });
    }

    const userId = req.user.sub;
    const { data: user } = await supabase
      .from('users')
      .select('email, stripe_customer_id, plan')
      .eq('id', userId)
      .single();

    if (user.plan === 'pro') {
      return reply.code(400).send({ error: 'Already on Pro plan' });
    }

    // Get or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { nexus_user_id: userId },
      });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', userId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: process.env.STRIPE_PRO_PRICE_ID,
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/billing/cancel`,
      metadata: { nexus_user_id: userId },
      subscription_data: {
        metadata: { nexus_user_id: userId },
      },
    });

    return reply.send({ url: session.url });
  });

  // ─── Customer portal (manage subscription) ────────────────────────────
  app.post('/portal', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!stripe) return reply.code(503).send({ error: 'Billing not configured' });

    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', req.user.sub)
      .single();

    if (!user?.stripe_customer_id) {
      return reply.code(400).send({ error: 'No billing account found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/settings/billing`,
    });

    return reply.send({ url: session.url });
  });

  // ─── Stripe webhook ────────────────────────────────────────────────────
  app.post('/webhook', {
    config: { rawBody: true }, // Need raw body for Stripe signature
  }, async (req, reply) => {
    if (!stripe) return reply.code(200).send();

    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody || req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      app.log.error('Stripe webhook signature failed:', err.message);
      return reply.code(400).send({ error: `Webhook Error: ${err.message}` });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.nexus_user_id;
        if (userId) {
          await supabase.from('users').update({
            plan: 'pro',
            stripe_subscription_id: session.subscription,
          }).eq('id', userId);
          app.io.to(`user:${userId}`).emit('plan:upgraded', { plan: 'pro' });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = sub.metadata?.nexus_user_id;
        if (userId) {
          const plan = sub.status === 'active' ? 'pro' : 'free';
          const expiresAt = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null;
          await supabase.from('users').update({
            plan,
            plan_expires_at: expiresAt,
          }).eq('id', userId);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('stripe_subscription_id', sub.id)
          .single();

        if (user) {
          await supabase.from('users').update({
            plan: 'free',
            stripe_subscription_id: null,
            plan_expires_at: null,
          }).eq('id', user.id);
          app.io.to(`user:${user.id}`).emit('plan:downgraded', { plan: 'free' });
        }
        break;
      }
    }

    return reply.send({ received: true });
  });
}

// ─── Plan features ─────────────────────────────────────────────────────────
function getPlanFeatures(plan) {
  if (plan === 'pro') {
    return {
      maxServers: Infinity,
      maxUploadMB: 100,
      messageHistoryDays: Infinity,
      voiceQuality: 'hd',
      screenShare: true,
      customThemes: true,
      prioritySupport: true,
      analyticsAccess: true,
    };
  }
  return {
    maxServers: 5,
    maxUploadMB: 10,
    messageHistoryDays: 90,
    voiceQuality: 'standard',
    screenShare: false,
    customThemes: false,
    prioritySupport: false,
    analyticsAccess: false,
  };
}
