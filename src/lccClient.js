// lccClient.js
// Minimal LCC client for Lennox S40 LAN.

const https = require("https");
const axiosLib = require("axios");

function messageTime(m) {
  if (!m || typeof m !== "object") return null;
  const raw =
    m.Timestamp ?? m.TimeStamp ?? m.timestamp ?? m.MessageTimestamp ?? m.PublishedOn ?? m.Time;
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
    const agent = new https.Agent({ rejectUnauthorized: this.verifyTLS, keepAlive: false });
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

  async _publish(body) {
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(`Publish -> ${res.status} ${this.logBodies && res.data ? JSON.stringify(res.data) : ""}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Publish failed: ${res.status}`);
    return res.data;
  }

  async connect() {
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
    const res = await this.axios.post(`/Messages/RequestData`, body);
    this.log(`[client] RequestData -> ${jsonPath} ${res.status}`);
    return res.data;
  }

  async retrieve({ startTime = 1, count = 50, timeoutSec = this.longPollSeconds } = {}) {
    const res = await this.axios.get(`/Messages/${encodeURIComponent(this.clientId)}/Retrieve`, {
      params: {
        Direction: "Oldest-to-Newest",
        MessageCount: String(count),
        StartTime: String(startTime),
        LongPollingTimeout: String(timeoutSec),
      },
    });
    if (res.status === 204 || !res.data) return { messages: [], nextStartTime: startTime };
    const raw = res.data.messages || res.data.Messages || [];
    const messages = Array.isArray(raw) ? raw : [];
    let maxTs = startTime;
    for (const m of messages) {
      const ts = messageTime(m);
      if (ts != null && ts > maxTs) maxTs = ts;
    }
    return { messages, nextStartTime: messages.length && maxTs > startTime ? maxTs + 1 : startTime };
  }

  async setZoneConfigScheduleHold(zoneId, scheduleHoldObj) {
    const zid = Number(zoneId);
    return this._publish({
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: { zones: [{ id: zid, config: { scheduleHold: scheduleHoldObj } }] },
      AdditionalParameters: { JSONPath: `zones[id=${zid}]/config/scheduleHold` },
    });
  }

  async setZoneHoldStatus(zoneId, { type = "temporary", expirationMode = "nextPeriod" } = {}) {
    const zid = Number(zoneId);
    return this._publish({
      MessageId: Date.now().toString(),
      MessageType: "PropertyChange",
      SenderId: this.clientId,
      TargetId: "tstat",
      data: { zones: [{ id: zid, status: { hold: { type, expirationMode } } }] },
      AdditionalParameters: { JSONPath: `zones[id=${zid}]/status/hold` },
    });
  }

  async setSchedulePeriod(scheduleId, periodId, period) {
    const sid = Number(scheduleId);
    const pid = Number(periodId);
    return this._publish({
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: { schedules: [{ id: sid, schedule: { periods: [{ id: pid, period }] } }] },
      AdditionalParameters: { JSONPath: `schedules[id=${sid}]/schedule/periods[id=${pid}]/period` },
    });
  }

  // Switch zone onto a schedule (manual = 16+zoneId). Matches lennoxs30api setSchedule.
  async setZoneSchedule(zoneId, scheduleId) {
    const zid = Number(zoneId);
    const sid = Number(scheduleId);
    return this._publish({
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: { zones: [{ id: zid, config: { scheduleId: sid } }] },
      AdditionalParameters: { JSONPath: `zones[id=${zid}]/config/scheduleId` },
    });
  }

  async setScheduleHold(zoneId, scheduleId, { hsp, csp, type = "temporary", expirationMode = "nextPeriod", duration } = {}) {
    const zid = Number(zoneId);
    const sid = Number(scheduleId);
    const hold = {
      type,
      expirationMode,
      scheduleId: sid,
      ...(Number.isFinite(duration) ? { duration: Math.round(duration) } : {}),
      period: {},
    };
    if (Number.isFinite(hsp)) hold.period.hsp = Math.round(hsp);
    if (Number.isFinite(csp)) hold.period.csp = Math.round(csp);
    return this._publish({
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: { zones: [{ id: zid, command: { setScheduleHold: hold } }] },
      AdditionalParameters: { JSONPath: "zones/command/setScheduleHold" },
    });
  }
}

module.exports = { LccClient };
