// index.js
//
// Homebridge platform for Lennox S40.
// Key change: route setpoints through schedule writer (hold scheduleId),
// cache it from live zone config, and keep an endpoint session alive.

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

    // cache: zoneId -> hold scheduleId (default 32 until we learn otherwise)
    this.holdScheduleId = new Map();
    for (const zid of this.zoneIds) this.holdScheduleId.set(zid, 32);

    api.on("didFinishLaunching", async () => {
      try {
        // Create sessions up-front
        await this.client.connect();
        await this.client.connectEndpoint();

        // Seed data so we can discover scheduleHold.scheduleId
        await this.client.requestData(["/devices", "/equipments", "/zones"]);

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
    // We register fresh accessories at launch; Homebridge caches them.
  }

  // Central helper used by accessories to write setpoints
  async setZoneSetpointsViaSchedule(zoneId, { hsp, csp }) {
    const sid = this.holdScheduleId.get(zoneId) ?? 32;
    const period = {};
    if (Number.isFinite(hsp)) period.hsp = Math.round(hsp);
    if (Number.isFinite(csp)) period.csp = Math.round(csp);
    this.log(`[LennoxS40] zone=${zoneId} write scheduleId=${sid} periodId=0 payload=${JSON.stringify(period)}`);
    return this.client.setSchedulePeriod(sid, 0, period);
  }

  async startPump() {
    let backoff = 2;
    for (;;) {
      try {
        const msgs = await this.client.retrieve({ count: 60, timeoutSec: this.longPollSeconds });
        backoff = 2;

        for (const m of msgs) {
          if (!m || !m.Data) continue;
          const data = m.Data;

          // zones-based updates
          if (Array.isArray(data.zones)) {
            for (const z of data.zones) {
              const zoneId = typeof z.id === "number" ? z.id : undefined;
              if (zoneId == null) continue;

              // capture hold schedule id if present
              const schedHold = z.config && z.config.scheduleHold;
              if (schedHold && typeof schedHold.scheduleId === "number") {
                const existing = this.holdScheduleId.get(zoneId);
                if (existing !== schedHold.scheduleId) {
                  this.holdScheduleId.set(zoneId, schedHold.scheduleId);
                  this.log(`[LennoxS40] zone=${zoneId} hold scheduleId -> ${schedHold.scheduleId}`);
                }
              }

              // push status to accessory
              const acc = this.zoneAccessories.get(zoneId);
              if (acc && z.status) acc.applyZoneStatus(z.status);
            }
          }

          // (Optional) You’ll also see “schedules” PropertyChange after writes.
        }
      } catch (e) {
        this.log.warn(`[LennoxS40] Retrieve error: ${e.message}`);
        // Reconnect & re-open endpoint session, then backoff
        try { await this.client.connect(); } catch {}
        try { await this.client.connectEndpoint(); } catch {}

        await new Promise(r => setTimeout(r, backoff * 1000));
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform("LennoxS40Platform", LennoxS40Platform);
};