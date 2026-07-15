import { getNodeInfo } from '@fedify/fedify';

export interface RemoteSoftwareInfo {
  readonly softwareName: string;
  readonly softwareVersion: string | null;
}

/**
 * Resolve a remote server's software metadata through Fedify's SSRF-safe
 * NodeInfo client.  Parsing remains intentionally loose because many
 * fediverse servers publish otherwise-invalid NodeInfo documents.
 */
export async function lookupRemoteSoftware(
  actorDomain: string,
  userAgent: string,
): Promise<RemoteSoftwareInfo | null> {
  const nodeInfo = await getNodeInfo(new URL(`https://${actorDomain}/`), {
    parse: 'none',
    userAgent,
  });
  if (!isRecord(nodeInfo) || !isRecord(nodeInfo.software)) return null;

  const softwareName = nodeInfo.software.name;
  if (typeof softwareName !== 'string' || softwareName.length === 0) return null;

  const version = nodeInfo.software.version;
  return {
    softwareName,
    softwareVersion: typeof version === 'string' ? version : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
