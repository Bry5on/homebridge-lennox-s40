const { LccClient } = require("./lccClient");
const { LennoxZoneAccessory } = require("./accessory");

class LennoxS40Platform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.host = this.config.host;
    this.clientId = this.config.clientId || "homebridge";
    this.zoneIds = Array.isArray(this.config.zoneIds) ? this.config.zoneIds : [0];
    this.verifyTLS = !!this.config.verifyTLS;
    this.longPollSeconds = Number(this.config.longPollSeconds || 15);
    this.logBodies = !!this.config.logBodies;

    if (!this.host) {
      this.log.error("[LennoxS40] No host configured.");
      return;
    }

    this.client = new LccClient({
      host: this.host,
      clientId: this.clientId,
      verifyTLS: this.verifyTLS,
      longPollSeconds: this.longPollSeconds,
      logBodies: this.logBodies,
      log: (m) => this.log.debug(m)
    });

    this.zoneAccessories = new Map();

    api.on("didFinishLaunching", async () => {
      try {
        await this.client.connect();
        await this.client.requestData(["/devices","/equipments","/zones"]);
        // Register zones
        for (const zoneId of this.zoneIds) {
          if (!this.zoneAccessories.has(zoneId)) {
            const acc = new LennoxZoneAccessory(this, zoneId);
            this.zoneAccessories.set(zoneId, acc);
          }
        }
        this.startPump();
      } catch (e) {
        this.log.error(`[LennoxS40] Startup failed: ${e.message}`);
      }
    });
  }

  configureAccessory() {
    // We register fresh accessories at launch; Homebridge will cache them automatically.
  }

  async startPump() {
    let backoff = 2;
    for (;;) {
      try {
        const msgs = await this.client.retrieve();
        backoff = 2;
        for (const m of msgs) {
          if (!m || !m.Data) continue;
          const data = m.Data;
          // zones-based updates
          if (Array.isArray(data.zones)) {
            for (const z of data.zones) {
              const zoneId = (typeof z.id === "number") ? z.id : undefined;
              if (zoneId == null) continue;
              const acc = this.zoneAccessories.get(zoneId);
              if (acc) acc.applyZoneStatus(z.status);
            }
          }
          // system/equipment messages can be logged or extended later
        }
      } catch (e) {
        this.log.warn(`[LennoxS40] Retrieve error: ${e.message}`);
        // reconnect and backoff
        try { await this.client.connect(); } catch {}
        await new Promise(r => setTimeout(r, backoff * 1000));
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform("LennoxS40Platform", LennoxS40Platform);
};
