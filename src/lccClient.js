const https = require("https");
const axiosLib = require("axios");

class LccClient {
  constructor(opts) {
    this.host = opts.host;
    this.clientId = opts.clientId || "homebridge";
    this.verifyTLS = !!opts.verifyTLS;
    this.longPollSeconds = Number(opts.longPollSeconds || 15);
    this.logBodies = !!opts.logBodies;
    this.log = typeof opts.log === "function" ? opts.log : () => {};

    const agent = new https.Agent({ rejectUnauthorized: this.verifyTLS });
    this.axios = axiosLib.create({
      baseURL: this.host.replace(/\/+$/, ""),
      httpsAgent: agent,
      timeout: 20000,
      headers: { "Content-Type": "application/json" },
      maxRedirects: 0,
      proxy: false,
    });
  }

  async connect() {
    this.log(`[client] Connect -> POST /Messages/${encodeURIComponent(this.clientId)}/Connect`);
    try {
      const res = await this.axios.post(`/Messages/${encodeURIComponent(this.clientId)}/Connect`);
      this.log(`[client] Connect -> ${res.status}`);
    } catch (e) {
      this.log(`[client] Connect soft error: ${e.message}`);
    }
  }

  async connectEndpoint() {
    try {
      const res = await this.axios.post(`/Endpoints/${encodeURIComponent(this.clientId)}/Connect`);
      this.log(`[client] ConnectEndpoint -> ${res.status}`);
      return res.status;
    } catch (e) {
      this.log(`[client] ConnectEndpoint soft error: ${e.message}`);
      return 0;
    }
  }

  async requestData(paths) {
    const jsonPath = `1;${paths.join(";")}`;
    const body = {
      MessageId: Date.now().toString(),
      MessageType: "RequestData",
      SenderId: this.clientId,
      TargetId: "LCC",
      AdditionalParameters: { JSONPath: jsonPath },
    };
    this.log(`[client] RequestData -> ${jsonPath}`);
    const res = await this.axios.post(`/Messages/RequestData`, body);
    this.log(`[client] RequestData -> ${res.status} ${this.logBodies ? JSON.stringify(res.data) : ""}`);
    return res.data;
  }

  async setZoneConfigScheduleHold(zoneId, scheduleHoldObj) {
    const zid = Number(zoneId);
    const body = {
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: { zones: [{ id: zid, config: { scheduleHold: scheduleHoldObj } }] },
      AdditionalParameters: { JSONPath: `zones[id=${zid}]/config/scheduleHold` },
    };
    this.log(`[client] setZoneConfigScheduleHold zid=${zid}`);
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(`Publish -> ${res.status} ${this.logBodies && res.data ? JSON.stringify(res.data) : ""}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Publish failed: ${res.status}`);
    return res.data;
  }

  async retrieve({ startTime = 1, count = 50, timeoutSec = this.longPollSeconds } = {}) {
    const url = `/Messages/${encodeURIComponent(this.clientId)}/Retrieve`;
    const params = {
      Direction: "Oldest-to-Newest",
      MessageCount: String(count),
      StartTime: String(startTime),
      LongPollingTimeout: String(timeoutSec),
    };
    const res = await this.axios.get(url, { params });
    if (!res.data || !res.data.messages) return [];
    if (this.logBodies) this.log(`[client] Retrieve -> ${JSON.stringify(res.data).slice(0, 300)}...`);
    return res.data.messages;
  }

  async setZoneHoldStatus(zoneId, { type = "temporary", expirationMode = "nextPeriod" } = {}) {
    const zid = Number(zoneId);
    const body = {
      MessageId: Date.now().toString(),
      MessageType: "PropertyChange",
      SenderId: this.clientId,
      TargetId: "tstat",
      data: { zones: [{ id: zid, status: { hold: { type, expirationMode } } }] },
      AdditionalParameters: { JSONPath: `zones[id=${zid}]/status/hold` },
    };
    this.log(`[client] setZoneHoldStatus zid=${zid}`);
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(`Publish -> ${res.status} ${this.logBodies && res.data ? JSON.stringify(res.data) : ""}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Publish failed: ${res.status}`);
    return res.data;
  }

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
            schedule: { periods: [{ id: safePeriodId, period }] },
          },
        ],
      },
      AdditionalParameters: {
        JSONPath: `schedules[id=${safeScheduleId}]/schedule/periods[id=${safePeriodId}]/period`,
      },
    };
    this.log(`[client] setSchedulePeriod sid=${safeScheduleId} pid=${safePeriodId}`);
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(`Publish -> ${res.status} ${this.logBodies && res.data ? JSON.stringify(res.data) : ""}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Publish failed: ${res.status}`);
    return res.data;
  }

  async setScheduleHold(zoneId, scheduleId, { hsp, csp, type = "temporary", expirationMode = "nextPeriod", duration } = {}) {
    const safeZoneId = Number(zoneId);
    const safeScheduleId = Number(scheduleId);
    const hold = {
      type,
      expirationMode,
      scheduleId: safeScheduleId,
      ...(Number.isFinite(duration) ? { duration: Math.round(duration) } : {}),
      period: {},
    };
    if (Number.isFinite(hsp)) hold.period.hsp = Math.round(hsp);
    if (Number.isFinite(csp)) hold.period.csp = Math.round(csp);

    const body = {
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: { zones: [{ id: safeZoneId, command: { setScheduleHold: hold } }] },
      AdditionalParameters: { JSONPath: "zones/command/setScheduleHold" },
    };
    this.log(`[client] setScheduleHold zid=${safeZoneId} sid=${safeScheduleId}`);
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(`Publish -> ${res.status} ${this.logBodies && res.data ? JSON.stringify(res.data) : ""}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Publish failed: ${res.status}`);
    return res.data;
  }
}

module.exports = { LccClient };
