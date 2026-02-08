import { CapabilityTier } from "./capabilityManager.js";

const STORAGE_PREFIX = "tabAccess:";
const SCOPE_PREFIX = "scopeAccess:";

export class PermissionGate {
  constructor({ emitThought }) {
    this.emitThought = emitThought;
    this.pending = new Map();
  }

  async hasScopeAccess(tabId, scopes = []) {
    if (!scopes.length) {
      return true;
    }

    const key = `${SCOPE_PREFIX}${tabId}`;
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry || !entry.expiresAt || Date.now() >= entry.expiresAt) {
      return false;
    }

    const granted = new Set(entry.scopes || []);
    return scopes.every((scope) => granted.has(scope));
  }

  async grantScopeAccess(tabId, scopes, ttlMs) {
    if (!ttlMs) {
      return;
    }
    const key = `${SCOPE_PREFIX}${tabId}`;
    const expiresAt = Date.now() + ttlMs;
    await chrome.storage.local.set({
      [key]: { scopes, expiresAt },
    });
  }

  async requestScopes({ tabId, scopes, reason }) {
    if (await this.hasScopeAccess(tabId, scopes)) {
      this.emitThought(`Scopes already granted for tab ${tabId}.`);
      return { approved: true, ttlMs: 0 };
    }

    this.emitThought(`Requesting scopes: ${scopes.join(", ")}.`);

    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      this.pending.set(requestId, {
        resolve,
        kind: "scopes",
        tabId,
        scopes,
      });
      chrome.runtime.sendMessage({
        type: "permission_request",
        requestId,
        tabId,
        scopes,
        reason,
        requestKind: "scopes",
      });
    });
  }

  async hasTimeBoundAccess(tabId) {
    const key = `${STORAGE_PREFIX}${tabId}`;
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry || !entry.expiresAt) {
      return false;
    }
    return Date.now() < entry.expiresAt;
  }

  async grantTimeBoundAccess(tabId, ttlMs) {
    const key = `${STORAGE_PREFIX}${tabId}`;
    const expiresAt = Date.now() + ttlMs;
    await chrome.storage.local.set({
      [key]: { expiresAt },
    });
  }

  async confirmAction({ tier, action, tabId }) {
    if (tier === CapabilityTier.ORACLE) {
      return true;
    }

    if (await this.hasTimeBoundAccess(tabId)) {
      this.emitThought(
        `Using existing time-bounded access for tab ${tabId}.`
      );
      return true;
    }

    this.emitThought(
      `Requesting explicit approval for ${action} (Tier ${tier}).`
    );

    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      this.pending.set(requestId, {
        resolve,
        kind: "action",
      });
      chrome.runtime.sendMessage({
        type: "permission_request",
        requestId,
        tier,
        action,
        tabId,
        requestKind: "action",
      });
    });
  }

  handlePermissionResponse(message) {
    const { requestId, approved, ttlMs, tabId } = message;
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }

    this.pending.delete(requestId);

    if (approved && entry.kind === "scopes" && tabId != null) {
      this.grantScopeAccess(tabId, entry.scopes, ttlMs).catch(() => {
        // Storage failures should not block user-approved actions.
      });
    }

    if (approved && ttlMs && tabId != null) {
      this.grantTimeBoundAccess(tabId, ttlMs).catch(() => {
        // Storage failures should not block user-approved actions.
      });
    }

    if (entry.kind === "scopes") {
      entry.resolve({ approved: Boolean(approved), ttlMs: ttlMs || 0 });
    } else {
      entry.resolve(Boolean(approved));
    }
  }
}
