// lccClient.js
// Minimal LCC client for Lennox S40 LAN.

const https = require("https");
const axiosLib = require("axios");

function messageTime(m) {
  if (!m || typeof m !== "object") return null;
  const raw =
    m.Timestamp ??
    m.TimeStamp ??
    m.timestamp ??
    m.MessageTimestamp ??
    m.PublishedOn ??
    m.Time;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class LccClient {
  constructor(opts) {
    this.host = opts.host;
    this.clientId = opts.clientId || "homebridge";
    this.verifyTLS = !!opts.verifyTLS;
    this.longPollSeconds = Number(opts.longPollSeconds || 15);
    this.logBodies = !!opts.logBodies;
    this.log = typeof opts.log === "function" ? opts.log : () => {};

    const agent = new https.Agent({
      rejectUnauthorized: this.verifyTLS,
      keepAlive: false,
    });

    const timeoutMs = Math.max(20_000, (this.longPollSeconds + 10) * 1000);

    this.axios = axiosLib.create({
      baseURL: String(this.host).replace(/\/+$/, ""),
      httpsAgent: agent,
      timeout: timeoutMs,
      headers: { "Content-Type": "application/json" },
      maxRedirects: 0,
      proxy: false,
      validateStatus: (s) => (s >= 200 && s < 300) || s === 204,
    });
  }

  async connect() {
    this.log(`[client] Connect -> POST /Messages/${encodeURIComponent(this.clientId)}/Connect`);
    try {
      const url = `/Messages/${encodeURIComponent(this.clientId)}/Connect`;
      const res = await this.axios.post(url);
      this.log(`[client] Connect -> ${res.status}`);
    } catch (e) {
      this.log(`[client] Connect soft error: ${e.message}`);
    }
  }

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
      data: {
        zones: [{ id: zid, config: { scheduleHold: scheduleHoldObj } }],
      },
      AdditionalParameters: {
        JSONPath: `zones[id=${zid}]/config/scheduleHold`,
      },
    };
    this.log(`[client] setZoneConfigScheduleHold zid=${zid} body=${JSON.stringify(body.data)}`);
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

    if (res.status === 204 || !res.data) {
      return { messages: [], nextStartTime: startTime };
    }

    const raw = res.data.messages || res.data.Messages || [];
    const messages = Array.isArray(raw) ? raw : [];

    if (this.logBodies) {
      this.log(`[client] Retrieve -> n=${messages.length} ${JSON.stringify(res.data).slice(0, 300)}...`);
    }

    let maxTs = startTime;
    for (const m of messages) {
      const ts = messageTime(m);
      if (ts != null && ts > maxTs) maxTs = ts;
    }
    const nextStartTime = messages.length && maxTs > startTime ? maxTs + 1 : startTime;
    return { messages, nextStartTime };
  }

  async setZoneHoldStatus(zoneId, { type = "temporary", expirationMode = "nextPeriod" } = {}) {
    const zid = Number(zoneId);
    const body = {
      MessageId: Date.now().toString(),
      MessageType: "PropertyChange",
      SenderId: this.clientId,
      TargetId: "tstat",
      data: {
        zones: [{ id: zid, status: { hold: { type, expirationMode } } }],
      },
      AdditionalParameters: {
        JSONPath: `zones[id=${zid}]/status/hold`,
      },
    };
    this.log(`[client] setZoneHoldStatus zid=${zid} body=${JSON.stringify(body.data)}`);
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
            schedule: {
              periods: [{ id: safePeriodId, period }],
            },
          },
        ],
      },
      AdditionalParameters: {
        JSONPath: `schedules[id=${safeScheduleId}]/schedule/periods[id=${safePeriodId}]/period`,
      },
    };
    this.log(`[client] setSchedulePeriod sid=${safeScheduleId} pid=${safePeriodId} body=${JSON.stringify(body.data)}`);
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(`Publish -> ${res.status} ${this.logBodies && res.data ? JSON.stringify(res.data) : ""}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Publish failed: ${res.status}`);
    return res.data;
  }

  async setScheduleHold(zoneId, scheduleId, { hsp, csp, type = "temporary", expirationMode = "nextPeriod", duration } = {}) {
    const safeZoneId = Number(zoneId);
    const safeScheduleId = Number(scheduleId);

    const body = {
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: {
        zones: [
          {
            id: safeZoneId,
            command: {
              setScheduleHold: {
                type,
                expirationMode,
                scheduleId: safeScheduleId,
                ...(Number.isFinite(duration) ? { duration: Math.round(duration) } : {}),
                period: {},
              },
            },
          },
        ],
      },
      AdditionalParameters: { JSONPath: "zones/command/setScheduleHold" },
    };

    if (Number.isFinite(hsp)) body.data.zones[0].command.setScheduleHold.period.hsp = Math.round(hsp);
    if (Number.isFinite(csp)) body.data.zones[0].command.setScheduleHold.period.csp = Math.round(csp);

    this.log(`[client] setScheduleHold zid=${safeZoneId} sid=${safeScheduleId} body=${JSON.stringify(body.data)}`);
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(`Publish -> ${res.status} ${this.logBodies && res.data ? JSON.stringify(res.data) : ""}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Publish failed: ${res.status}`);
    return res.data;
  }
}

module.exports = { LccClient };
