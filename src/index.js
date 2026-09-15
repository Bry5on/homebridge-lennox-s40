// index.js
//
// Homebridge platform for Lennox S40 (LCC LAN).
//
// Boot:
//  - restore cached zone accessories (stable UUID) unless resetOnBoot
//  - connect + RequestData, then long-poll Retrieve
//
// Child bridge: add `_bridge` in config. No plugin API change required.

const path = require("path");
const { LccClient } = require("./lccClient");
const { LennoxZoneAccessory } = require("./accessory");

const PLUGIN_NAME = "homebridge-lennox-s40";
const PLATFORM_NAME = "LennoxS40Platform";

function readPluginVersion() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version;
  } catch {
    return "0.0.0";
  }
}

class LennoxS40Platform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.pluginVersion = readPluginVersion();

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.host = this.config.host;
    this.clientId = this.config.clientId || "homebridge";
    this.zoneIds = Array.isArray(this.config.zoneIds) ? this.config.zoneIds : [0];
    this.verifyTLS = !!this.config.verifyTLS;
    this.longPollSeconds = Number(this.config.longPollSeconds || 15);
    this.logBodies = !!this.config.logBodies;
    this.resetOnBoot = this.config.resetOnBoot === true;

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
      log: (m) => this.log.debug(m),
    });

    this.cachedByUUID = new Map();
    this.cachedByZoneId = new Map();
    this.zoneAccessories = new Map();

    this.holdScheduleId = new Map();
    for (const zid of this.zoneIds) this.holdScheduleId.set(zid, 32 + zid);

    this._pumpRunning = false;
    this._retrieveStartTime = 1;

    api.on("didFinishLaunching", async () => {
      try {
        if (this.resetOnBoot && this.cachedByUUID.size > 0) {
          const stale = Array.from(this.cachedByUUID.values());
          this.log.warn(`[LennoxS40] resetOnBoot=true: pruning ${stale.length} cached accessory(ies).`);
          try {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
          } catch (e) {
            this.log.warn(`[LennoxS40] prune error: ${e.message}`);
          }
          this.cachedByUUID.clear();
          this.cachedByZoneId.clear();
          await new Promise((r) => setTimeout(r, 200));
        }

        await this.sessionStart();

        for (const zoneId of this.zoneIds) {
          if (!this.zoneAccessories.has(zoneId)) {
            const cached = this.cachedByZoneId.get(zoneId) || null;
            const acc = new LennoxZoneAccessory(this, zoneId, cached);
            this.zoneAccessories.set(zoneId, acc);
          }
        }

        this.startPump();
      } catch (e) {
        this.log.error(`[LennoxS40] Startup failed: ${e.message}`);
        this.startPump();
      }
    });
  }

  configureAccessory(accessory) {
    this.cachedByUUID.set(accessory.UUID, accessory);
    const zid = accessory?.context?.zoneId;
    if (typeof zid === "number") this.cachedByZoneId.set(zid, accessory);
  }

  async sessionStart() {
    await this.client.connect();
    await this.client.connectEndpoint();
    await this.client.requestData(["/devices", "/equipments", "/zones"]);
    this._retrieveStartTime = 1;
  }

  async setZoneSetpointsViaSchedule(zoneId, { hsp, csp }) {
    const sid = this.holdScheduleId.get(zoneId) ?? (32 + zoneId);
    const period = {};
    if (Number.isFinite(hsp)) period.hsp = Math.round(hsp);
    if (Number.isFinite(csp)) period.csp = Math.round(csp);

    this.log(`[LennoxS40] zone=${zoneId} scheduleId=${sid} periodId=0 write -> ${JSON.stringify(period)}`);
    await this.client.setSchedulePeriod(sid, 0, period);
    await new Promise((r) => setTimeout(r, 150));

    let holdArmed = false;

    if (typeof this.client.setZoneConfigScheduleHold === "function") {
      try {
        await this.client.setZoneConfigScheduleHold(zoneId, {
          enabled: true,
          exceptionType: "hold",
          scheduleId: sid,
          expirationMode: "nextPeriod",
          expiresOn: "0",
        });
        this.log(`[LennoxS40] zone=${zoneId} armed hold via zones/config/scheduleHold`);
        holdArmed = true;
      } catch (e) {
        this.log.warn(`[LennoxS40] zones/config/scheduleHold failed: ${e.message}`);
      }
    }

    if (!holdArmed && typeof this.client.setScheduleHold === "function") {
      try {
        await this.client.setScheduleHold(zoneId, sid, {
          hsp: period.hsp,
          csp: period.csp,
          type: "temporary",
          expirationMode: "nextPeriod",
        });
        this.log(`[LennoxS40] zone=${zoneId} armed hold via setScheduleHold`);
        holdArmed = true;
      } catch (e) {
        this.log.warn(`[LennoxS40] setScheduleHold failed: ${e.message}`);
      }
    }

    if (!holdArmed && typeof this.client.setZoneHoldStatus === "function") {
      try {
        await this.client.setZoneHoldStatus(zoneId, {
          type: "temporary",
          expirationMode: "nextPeriod",
        });
        this.log(`[LennoxS40] zone=${zoneId} armed hold via zones/status/hold`);
        holdArmed = true;
      } catch (e) {
        this.log.warn(`[LennoxS40] zones/status/hold failed: ${e.message}`);
      }
    }

    try { await this.client.requestData(["/zones"]); } catch {}
    if (!holdArmed) this.log.warn("[LennoxS40] Hold might not be armed (no supported hold method succeeded).");
  }

  applyMessages(msgs) {
    for (const m of msgs) {
      if (!m) continue;
      const data = m.Data || m.data;
      if (!data || !Array.isArray(data.zones)) continue;

      for (const z of data.zones) {
        const zoneId = typeof z.id === "number" ? z.id : undefined;
        if (zoneId == null) continue;

        const schedHold = z.config && z.config.scheduleHold;
        if (schedHold && typeof schedHold.scheduleId === "number") {
          const existing = this.holdScheduleId.get(zoneId);
          if (existing !== schedHold.scheduleId) {
            this.holdScheduleId.set(zoneId, schedHold.scheduleId);
            this.log(`[LennoxS40] zone=${zoneId} hold scheduleId -> ${schedHold.scheduleId}`);
          }
        }

        const acc = this.zoneAccessories.get(zoneId);
        if (acc && z.status) acc.applyZoneStatus(z.status);
      }
    }
  }

  async startPump() {
    if (this._pumpRunning) return;
    this._pumpRunning = true;

    let backoff = 2;
    for (;;) {
      try {
        const { messages, nextStartTime } = await this.client.retrieve({
          startTime: this._retrieveStartTime,
          count: 60,
          timeoutSec: this.longPollSeconds,
        });
        backoff = 2;

        if (messages.length) {
          this.applyMessages(messages);
          if (nextStartTime != null) this._retrieveStartTime = nextStartTime;
        }
      } catch (e) {
        this.log.warn(`[LennoxS40] Retrieve error: ${e.message}`);
        try {
          await this.sessionStart();
          this.log("[LennoxS40] Session re-established; RequestData re-issued.");
        } catch (re) {
          this.log.warn(`[LennoxS40] Reconnect failed: ${re.message}`);
        }
        await new Promise((r) => setTimeout(r, backoff * 1000));
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, LennoxS40Platform);
};
