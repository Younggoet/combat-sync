/**
 * Combat — web-push helper
 *
 * Thin wrapper around the `web-push` library, used by every function that
 * needs to notify subscribed devices: draft-pick.js ("you're on the
 * clock"), send-chat-message.js (new league chat message), and
 * news-sync.js (new combat-sports article).
 *
 * VAPID keys: the public key is not secret (it's handed to every
 * subscribing browser, see combat-app/notifications.html) and is inlined
 * there directly. The PRIVATE key must be set as a Netlify environment
 * variable (VAPID_PRIVATE_KEY) — it is never committed to this repo.
 * VAPID_SUBJECT should be a mailto: address or site URL (web-push
 * requires one); falls back to a placeholder if unset so this never
 * throws in an environment where it hasn't been configured yet.
 */

const webpush = require('web-push');

const VAPID_PUBLIC_KEY = 'BKoDOfqrfsn8hb2FsAnfNeSP7ATTkgDYW7F9VdCvZmE4TbDd1VfEY9HFIwYdsXoXVZgTqGN0C3Ag0F8S5zr3HYI';

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('VAPID_PRIVATE_KEY is not set — push notifications are not configured on this deploy yet.');
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@combat.app',
    VAPID_PUBLIC_KEY,
    privateKey
  );
  configured = true;
}

/**
 * Sends one push notification to every subscription matching the given
 * trigger (and, for 'pick', the given team). Best-effort: a failure to
 * send to one subscriber never throws — it's logged and that subscriber
 * is skipped (and deleted if the push service says the subscription is
 * gone, i.e. 404/410).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {'pick'|'chat'|'news'} trigger
 * @param {{title: string, body: string, url?: string}} payload
 * @param {{teamId?: string}} [opts] - required (teamId) for trigger 'pick'
 * @returns {Promise<{sent: number, removed: number, skipped: boolean, reason?: string}>}
 */
async function notifySubscribers(supabase, trigger, payload, opts = {}) {
  try {
    ensureConfigured();
  } catch (err) {
    // Not configured yet on this deploy — don't fail the caller's main
    // job (a pick, a chat message, a news sync) over a missing env var.
    return { sent: 0, removed: 0, skipped: true, reason: err.message };
  }

  const column = { pick: 'notify_pick', chat: 'notify_chat', news: 'notify_news' }[trigger];
  if (!column) {
    return { sent: 0, removed: 0, skipped: true, reason: `Unknown trigger "${trigger}"` };
  }

  let query = supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq(column, true);

  if (trigger === 'pick') {
    if (!opts.teamId) {
      return { sent: 0, removed: 0, skipped: true, reason: 'trigger "pick" requires opts.teamId' };
    }
    query = query.eq('team_id', opts.teamId);
  }

  const { data: subs, error } = await query;
  if (error) {
    return { sent: 0, removed: 0, skipped: true, reason: `Subscription lookup failed: ${error.message}` };
  }
  if (!subs || subs.length === 0) {
    return { sent: 0, removed: 0, skipped: false };
  }

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url || '/',
  });

  let sent = 0;
  const deadIds = [];

  await Promise.all(
    subs.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(pushSubscription, body);
        sent++;
      } catch (err) {
        // 404/410 = the push service says this subscription no longer
        // exists (browser data cleared, permission revoked, etc.) —
        // clean it up so we stop trying. Any other error just skips this
        // one subscriber for this notification.
        if (err.statusCode === 404 || err.statusCode === 410) {
          deadIds.push(sub.id);
        }
      }
    })
  );

  if (deadIds.length > 0) {
    await supabase.from('push_subscriptions').delete().in('id', deadIds);
  }

  return { sent, removed: deadIds.length, skipped: false };
}

module.exports = { notifySubscribers, VAPID_PUBLIC_KEY };
