import { env } from 'cloudflare:workers';
import type { RegistrationQueueMessage } from '../../../packages/shared/types/registration';

export async function handleRegistration(message: RegistrationQueueMessage): Promise<void> {
  await env.INTERNAL_CONNECTION_MAIN.applyRegistration(message.command);
}
