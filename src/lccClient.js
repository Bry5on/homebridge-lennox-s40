// lccClient.js
//
// Minimal LCC client used by the LennoxS40 Homebridge platform.
// Adds schedule-based setpoint writer + endpoint Connect helper.

const https = require("https");
const axiosLib = require("axios");

class LccClient {
  constructor(opts) {
    this.host = opts.host;                               // e.g. https://192.168.1.10
    this.clientId = opts.clientId || "homebridge";
    this.verifyTLS = !!opts.verifyTLS;
    this.longPollSeconds = Number(opts.longPollSeconds || 15);
    this.logBodies = !!opts.logBodies;
    this.log = typeof opts.log === "function" ? opts.log : () => {};

    // Axios w/ relaxed TLS if requested
    const agent = new https.Agent({ rejectUnauthorized: this.verifyTLS });
    this.axios = axiosLib.create({
      baseURL: this.host.replace(/\/+$/, ""),            // no trailing slash
      httpsAgent: agent,
      timeout: 20000,
      headers: { "Content-Type": "application/json" },
      // device sometimes closes idle keep-alives; don’t keep sockets forever
      maxRedirects: 0,
      // no proxy
      proxy: false
    });
  }

  // Establishes server-side message session for SenderId (you) — stays cheap.
  async connect() {
    // The S40 doesn’t strictly require this call before Publish/RequestData,
    // but it’s harmless and gives a deterministic “session”.
    this.log(`[client] Connect -> POST /Messages/${encodeURIComponent(this.clientId)}/Connect`);
    try {
      const url = `/Messages/${encodeURIComponent(this.clientId)}/Connect`;
      const res = await this.axios.post(url);
      this.log(`[client] Connect -> ${res.status}`);
    } catch (e) {
      // Some firmwares 204 here; treat as soft.
      this.log(`[client] Connect soft error: ${e.message}`);
    }
  }

  // Optional: explicitly open an Endpoint session to prevent “no active connection”
  async connectEndpoint() {
    try {
      const url = `/Endpoints/${encodeURIComponent(this.clientId)}/Connect`;
      const res = await this.axios.post(url);
      this.log(`[client] ConnectEndpoint -> ${res.status}`);
      return res.status;
    } catch (e) {
      this.log(`[client] ConnectEndpoint soft error: ${e.message}`);
      return 0;
    }
  }

  // Ask the S40 to push objects back via PropertyChange (“1;” prefix means “since 1”)
  async requestData(paths /* array of “/zones”, “/devices”, ... */) {
    const jsonPath = `1;${paths.join(";")}`;
    const body = {
      MessageId: Date.now().toString(),
      MessageType: "RequestData",
      SenderId: this.clientId,
      TargetId: "LCC",
      AdditionalParameters: { JSONPath: jsonPath }
    };
    this.log(`[client] RequestData -> ${jsonPath}`);
    const res = await this.axios.post(`/Messages/RequestData`, body);
    this.log(`[client] RequestData -> ${res.status} ${this.logBodies ? JSON.stringify(res.data) : ""}`);
    return res.data;
  }

  // Long-poll retrieve any messages for our SenderId
  async retrieve({ startTime = 1, count = 50, timeoutSec = this.longPollSeconds } = {}) {
    const url = `/Messages/${encodeURIComponent(this.clientId)}/Retrieve`;
    const params = {
      Direction: "Oldest-to-Newest",
      MessageCount: String(count),
      StartTime: String(startTime),
      LongPollingTimeout: String(timeoutSec)
    };
    const res = await this.axios.get(url, { params });
    // 204 (no content) can happen – normalize to empty list
    if (!res.data || !res.data.messages) return [];
    if (this.logBodies) this.log(`[client] Retrieve -> ${JSON.stringify(res.data).slice(0, 300)}...`);
    return res.data.messages;
  }

  // **** S E T P O I N T S   V I A   S C H E D U L E ****
  // Write a single period object into a schedule/period (this is what the S40 honors).
  async setSchedulePeriod(scheduleId, periodId, period) {
    const safeScheduleId = Number(scheduleId);
    const safePeriodId = Number(periodId);
    const body = {
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: {
        schedules: [
          {
            id: safeScheduleId,
            schedule: {
              periods: [{ id: safePeriodId, period }]
            }
          }
        ]
      },
      AdditionalParameters: {
        JSONPath: `schedules[id=${safeScheduleId}]/schedule/periods[id=${safePeriodId}]/period`
      }
    };
    this.log(`[client] setSchedulePeriod sid=${safeScheduleId} pid=${safePeriodId} body=${JSON.stringify(body.data)}`);
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(`Publish -> ${res.status} ${this.logBodies && res.data ? JSON.stringify(res.data) : ""}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Publish failed: ${res.status}`);
    return res.data;
  }
}

module.exports = { LccClient };