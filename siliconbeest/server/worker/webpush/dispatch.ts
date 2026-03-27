/**
 * Web Push Notification Dispatch
 *
 * Orchestrates VAPID authentication and RFC 8291 encryption to
 * deliver a push notification to a subscriber's push service.
 */

import { encryptPushPayload } from './encrypt';
import { generateVapidAuth } from './vapid';

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushResult {
  /** Whether the push service accepted the message (2xx status) */
  success: boolean;
  /** HTTP status code from the push service */
  status: number;
  /** Whether the subscription is expired/invalid (410 Gone or 404 Not Found) */
  gone: boolean;
}

/**
 * Send a Web Push notification.
 *
 * @param subscription - Push subscription with endpoint and encryption keys
 * @param payload - JSON string payload to encrypt and deliver
 * @param vapidPrivateKey - Base64url VAPID private key (32 bytes)
 * @param vapidPublicKey - Base64url VAPID public key (65 bytes uncompressed)
 * @param vapidSubject - Contact URI (mailto: or https:)
 * @returns Result indicating success/failure and whether the subscription is stale
 */
export async function sendPushNotification(
  subscription: PushSubscription,
  payload: string,
  vapidPrivateKey: string,
  vapidPublicKey: string,
  vapidSubject: string,
): Promise<PushResult> {
  // 1. Generate VAPID Authorization header
  const audience = new URL(subscription.endpoint).origin;
  const authorization = await generateVapidAuth(
    audience,
    vapidSubject,
    vapidPrivateKey,
    vapidPublicKey,
  );

  // 2. Encrypt the payload per RFC 8291
  const encrypted = await encryptPushPayload(
    payload,
    subscription.keys.p256dh,
    subscription.keys.auth,
  );

  // 3. POST to the push service
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ...encrypted.headers,
      Authorization: authorization,
      TTL: '86400', // 24 hours
      Urgency: 'normal',
      'User-Agent': 'SiliconBeest/1.0 (WebPush; +https://github.com/SJang1/siliconbeest)',
    },
    body: encrypted.body,
  });

  const status = response.status;

  return {
    success: status >= 200 && status < 300,
    status,
    gone: status === 410 || status === 404,
  };
}
