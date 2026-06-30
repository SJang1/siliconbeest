import { env } from 'cloudflare:workers';

export function getRepositoryUrl(): string {
  return env.REPOSITORY_URL || `https://${env.INSTANCE_DOMAIN}`;
}

export function getUserAgent(context?: string): string {
  const repositoryUrl = getRepositoryUrl();
  return context
    ? `SiliconBeest/1.0 (${context}; +${repositoryUrl})`
    : `SiliconBeest/1.0 (+${repositoryUrl})`;
}
