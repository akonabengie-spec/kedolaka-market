'use strict';

function isConfiguredDatabaseUrl(value) {
  if (typeof value !== 'string') return false;

  const candidate = value.trim();
  if (!candidate) return false;
  if (candidate.includes('******')) return false;
  if (candidate.includes('replace-with-')) return false;
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) return false;

  try {
    const url = new URL(candidate);
    const protocol = url.protocol.toLowerCase();
    const hasHost = Boolean(url.hostname);
    const hasDatabaseName = Boolean(url.pathname.replace(/^\/+/, ''));
    return (protocol === 'postgres:' || protocol === 'postgresql:') && hasHost && hasDatabaseName;
  } catch {
    return false;
  }
}

module.exports = { isConfiguredDatabaseUrl };
