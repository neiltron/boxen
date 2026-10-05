// pi-ai CredentialStore backed by the Directory cell, so every Session cell
// shares one login and sees the others' OAuth refreshes.
// ponytail: no cross-cell lock; two cells refreshing at once can race on a
// rotating refresh token. Move modify() into the Directory if that bites.
export function directoryCredentials(directory) {
  return {
    read: (providerId) => directory.credential(providerId),
    list: () => directory.credentialList(),
    async modify(providerId, fn) {
      const current = await directory.credential(providerId);
      const next = await fn(current);
      if (next !== undefined) await directory.setCredential(providerId, next);
      return next ?? current;
    },
    delete: (providerId) => directory.deleteCredential(providerId),
  };
}
