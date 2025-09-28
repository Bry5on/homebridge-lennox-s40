// src/lccClient.js
const axios = require("axios");
const https = require("https");

class LccClient {
  /**
   * @param {{host:string, clientId?:string, verifyTLS?:boolean, longPollSeconds?:number, logBodies?:boolean, log?: Function}} opts
   */
  constructor(opts) {
    this.host = opts.host;
    this.clientId = opts.clientId || "homebridge";
    this.verifyTLS = !!opts.verifyTLS;
    this.longPollSeconds = opts.longPollSeconds || 15;
    this.logBodies = !!opts.logBodies;
    this.log = opts.log || (()=>{});
    this.connected = false;

    this.axios = axios.create({
      baseURL: `https://${this.host}`,
      timeout: 30000,
      httpsAgent: new https.Agent({ rejectUnauthorized: this.verifyTLS }),
      validateStatus: () => true
    });
  }

  async connect() {
    const res = await this.axios.post(`/Endpoints/${encodeURIComponent(this.clientId)}/Connect`);
    this.log(`Connect -> ${res.status}`);
    if (res.status >= 200 && res.status < 300) {
      this.connected = true;
      return;
    }
    throw new Error(`Connect failed: ${res.status}`);
  }

  async disconnect() {
    const res = await this.axios.post(`/Endpoints/${encodeURIComponent(this.clientId)}/Disconnect`);
    this.log(`Disconnect -> ${res.status}`);
    this.connected = false;
  }

  async publish(dataTopKey, payload) {
    const body = {
      MessageId: Date.now().toString(),
      MessageType: "Command",
      SenderId: this.clientId,
      TargetId: "LCC",
      data: { [dataTopKey]: payload },
      AdditionalParameters: { JSONPath: dataTopKey }
    };
    const res = await this.axios.post(`/Messages/Publish`, body);
    this.log(
      `Publish -> ${res.status}` +
      (this.logBodies && res.data ? ` ${JSON.stringify(res.data).slice(0,200)}` : "")
    );
    this.log(`[client] PUBLISH ${dataTopKey}: ${JSON.stringify(body)}`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Publish failed: ${res.status}`);
    }
    return res;
  }

  async requestData(paths = ["/devices","/equipments","/zones"]) {
    const body = {
      MessageId: Date.now().toString(),
      MessageType: "RequestData",
      SenderId: this.clientId,
      TargetId: "LCC",
      AdditionalParameters: { JSONPath: `1;${paths.join(";")}` }
    };
    const res = await this.axios.post(`/Messages/RequestData`, body);
    this.log(
      `RequestData -> ${res.status}` +
      (this.logBodies && res.data ? ` ${JSON.stringify(res.data).slice(0,200)}` : "")
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`RequestData failed: ${res.status}`);
    }
    return res.data;
  }

  // Long-poll retrieve messages
  async retrieve() {
    const params = {
      Direction: "Oldest-to-Newest",
      MessageCount: "10",
      StartTime: "1",
      LongPollingTimeout: String(this.longPollSeconds)
    };
    const url = `/Messages/${encodeURIComponent(this.clientId)}/Retrieve`;
    const res = await this.axios.get(url, { params });
    if (this.logBodies) {
      this.log(`Retrieve -> ${res.status} ${
        typeof res.data === "object" ? JSON.stringify(res.data).slice(0,200) : String(res.data).slice(0,200)
      }`);
    } else {
      this.log(`Retrieve -> ${res.status} `);
    }
    if (res.status !== 200) throw new Error(`Retrieve failed: ${res.status}`);
    const data = res.data;
    if (!data || !Array.isArray(data.messages)) return [];
    return data.messages;
  }

  async setZoneMode(zoneId, mode) {
    const payload = [{ id: Number(zoneId), status: { period: { systemMode: mode } } }];
    this.log(`[client] setZoneMode zone=${zoneId} payload=${JSON.stringify(payload)}`);
    const res = await this.publish("zones", payload);
    this.log(`[client] zones publish result -> ${res.status}`);
    return res.data;
  }

  async setZoneSetpoints(zoneId, { csp, hsp /*, mode */ }) {
    const period = {};
    if (Number.isFinite(hsp)) period.hsp = Math.round(hsp); // °F integer
    if (Number.isFinite(csp)) period.csp = Math.round(csp); // °F integer
    // if (typeof mode === "string") period.systemMode = mode;

    // If your S40 needs a hold, uncomment:
    // const hold = { type: "permanent" };

    const payload = [{
      id: Number(zoneId),
      status: {
        period,
        // hold
      }
    }];

    this.log(`[client] setZoneSetpoints zone=${zoneId} payload=${JSON.stringify(payload)}`);

    const res = await this.publish("zones", payload);
    this.log(
      `[client] zones publish result -> ${res.status}` +
      (this.logBodies && res.data ? ` ${JSON.stringify(res.data).slice(0,200)}` : "")
    );
    return res.data;
  }
}

module.exports = { LccClient };