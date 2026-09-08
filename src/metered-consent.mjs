import { createHash, randomUUID } from "node:crypto";
import { projectQuotaSnapshot } from "./agent-resource.mjs";

const CONSENT_TTL_MS = 10 * 60_000;

function requestHash(action, subjectRef, payload) {
  return createHash("sha256")
    .update(JSON.stringify({ action, subjectRef, payload }), "utf8")
    .digest("hex");
}

export class MeteredConsentGate {
  #mode;
  #quotaProvider;
  #maxRecords;
  #records = new Map();

  constructor({ mode = "off", quotaProvider = null, maxRecords = 10_000 } = {}) {
    if (!new Set(["off", "always"]).has(mode)) throw new Error("metered consent mode must be off or always");
    if (quotaProvider !== null && typeof quotaProvider !== "function") {
      throw new Error("metered consent quotaProvider must be a function when provided");
    }
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000) {
      throw new Error("metered consent maxRecords must be 1..100000");
    }
    this.#mode = mode;
    this.#quotaProvider = quotaProvider;
    this.#maxRecords = maxRecords;
  }

  get mode() { return this.#mode; }

  async authorize({ action, requestId, subjectRef = null, payload, consentRef = null }) {
    if (!new Set(["start", "send"]).has(action)) throw new Error("metered consent action must be start or send");
    if (typeof requestId !== "string" || !requestId || requestId !== requestId.trim() || requestId.length > 512) {
      throw new Error("metered consent requestId must be an exact non-empty string of at most 512 characters");
    }
    const boundPayload = structuredClone(payload);
    const hash = requestHash(action, subjectRef, boundPayload);
    if (this.#mode === "off") return { authorized: true, mode: "off", consentRef: null, duplicate: false };

    const prior = this.#records.get(requestId);
    if (prior) {
      if (prior.requestHash !== hash) {
        throw new Error(`requestId was already used for a different metered ${action} request: ${requestId}`);
      }
      if (consentRef !== null && consentRef !== prior.consentRef) {
        throw new Error(`consentRef does not match the pending metered ${action} request`);
      }
      if (prior.ready) await prior.ready;
      if (prior.error) throw new Error(prior.error);
      if (!prior.authorized && prior.expiresAt <= Date.now()) {
        // Keep the compact binding: forgetting it would allow another account
        // or payload to revive a request ID after its consent expired.
        prior.quota = null;
        throw new Error(`consentRef is expired for this metered ${action} request; prepare the task again with a new requestId`);
      }
      if (prior.authorized) {
        if (consentRef !== prior.consentRef) return this.#required(prior, true);
        return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: true };
      }
      if (consentRef === prior.consentRef) {
        prior.authorized = true;
        prior.authorizedAt = Date.now();
        return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: false };
      }
      return this.#required(prior, true);
    }

    if (consentRef !== null) throw new Error("consentRef is unknown or stale for this metered requestId");
    if (this.#records.size >= this.#maxRecords) {
      throw Object.assign(new Error("Metered consent capacity reached; existing bindings will not be evicted to accept new work"), { code: "CODEX_CONSENT_CAPACITY" });
    }
    const record = {
      action, subjectRef, requestId, requestHash: hash,
      consentRef: `consent_${randomUUID()}`,
      quota: null, createdAt: Date.now(), expiresAt: null,
      authorized: false, authorizedAt: null, ready: null, error: null,
    };
    // Reserve before the first await, including quota-provider execution.
    this.#records.set(requestId, record);
    record.ready = Promise.resolve().then(async () => {
      let quotaSnapshot;
      try {
        quotaSnapshot = this.#quotaProvider
          ? await this.#quotaProvider({ action, requestId, subjectRef, payload: boundPayload })
          : { status: "unavailable", observedAt: new Date().toISOString(), usage: { status: "unavailable" }, rateLimits: { status: "unavailable" } };
      } catch {
        const projected = { name: "Unavailable", message: "Account quota telemetry is unavailable" };
        quotaSnapshot = {
          status: "unavailable", observedAt: new Date().toISOString(),
          usage: { status: "unavailable", error: projected }, rateLimits: { status: "unavailable", error: projected },
        };
      }
      record.quota = projectQuotaSnapshot(quotaSnapshot);
      record.expiresAt = Date.now() + CONSENT_TTL_MS;
    }).catch(() => {
      record.error = "Metered consent preparation failed; prepare a new requestId";
      throw new Error(record.error);
    });
    try { await record.ready; }
    finally { record.ready = null; }
    return this.#required(record, false);
  }

  #required(record, duplicate) {
    return {
      authorized: false, mode: "always", duplicate,
      consent: {
        status: "required", consentRef: record.consentRef,
        action: record.action, subjectRef: record.subjectRef,
        requestId: record.requestId, expiresAt: record.expiresAt,
        quota: structuredClone(record.quota),
        message: "This action starts metered Codex model work. Ask the user to approve this exact call before retrying with the same requestId and consentRef.",
      },
    };
  }
}
