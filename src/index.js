const { LccClient } = require("./lccClient");
const { LennoxZoneAccessory, zoneUuid } = require("./accessory");
const pkg = require("../package.json");

const PLUGIN_NAME = "homebridge-lennox-s40";
const PLATFORM_NAME = "LennoxS40Platform";

class LennoxS40Platform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.pluginName = PLUGIN_NAME;
    this.platformName = PLATFORM_NAME;
    this.pluginVersion = pkg.version;
    this.displayName = this.config.name || pkg.displayName || "Lennox S40";

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
      this.log.error("[Lennox S40] No host configured.");
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
    this.zoneAccessories = new Map();
    this.holdScheduleId = new Map();
    for (const zid of this.zoneIds) this.holdScheduleId.set(zid, 32 + zid);

    api.on("didFinishLaunching", async () => {
      try {
        if (this.resetOnBoot && this.cachedByUUID.size > 0) {
          const stale = Array.from(this.cachedByUUID.values());
          this.log.warn(`[Lennox S40] resetOnBoot: removing ${stale.length} cached accessory(ies); Grafana/HomeKit IDs will change.`);
          try {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
          } catch (e) {
            this.log.warn(`[Lennox S40] prune error: ${e.message}`);
          }
          this.cachedByUUID.clear();
          await new Promise((r) => setTimeout(r, 200));
        }

        await this.client.connect();
        await this.client.connectEndpoint();
        await this.client.requestData(["/devices", "/equipments", "/zones"]);

        const multi = this.zoneIds.length > 1;
        const keep = new Set();

        for (const zoneId of this.zoneIds) {
          const uuid = zoneUuid(this.api, zoneId);
          keep.add(uuid);
          const cached = this.cachedByUUID.get(uuid);
          const name = multi ? `${this.displayName} Zone ${zoneId}` : this.displayName;
          const acc = new LennoxZoneAccessory(this, zoneId, name, cached || null);
          this.zoneAccessories.set(zoneId, acc);
        }

        const extras = [];
        for (const [uuid, acc] of this.cachedByUUID) {
          if (!keep.has(uuid)) extras.push(acc);
        }
        if (extras.length) {
          this.log(`[Lennox S40] unregistering ${extras.length} accessory(ies) no longer in zoneIds`);
          try {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, extras);
          } catch (e) {
            this.log.warn(`[Lennox S40] extra prune error: ${e.message}`);
          }
        }

        this.startPump();
      } catch (e) {
        this.log.error(`[Lennox S40] Startup failed: ${e.message}`);
      }
    });
  }

  configureAccessory(accessory) {
    this.cachedByUUID.set(accessory.UUID, accessory);
  }

  async setZoneSetpointsViaSchedule(zoneId, { hsp, csp }) {
    const sid = this.holdScheduleId.get(zoneId) ?? (32 + zoneId);
    const period = {};
    if (Number.isFinite(hsp)) period.hsp = Math.round(hsp);
    if (Number.isFinite(csp)) period.csp = Math.round(csp);

    this.log(`[Lennox S40] zone=${zoneId} scheduleId=${sid} period 0 -> ${JSON.stringify(period)}`);
    await this.client.setSchedulePeriod(sid, 0, period);
    await new Promise((r) => setTimeout(r, 150));

    let holdArmed = false;

    try {
      await this.client.setZoneConfigScheduleHold(zoneId, {
        enabled: true,
        exceptionType: "hold",
        scheduleId: sid,
        expirationMode: "nextPeriod",
        expiresOn: "0",
      });
      this.log(`[Lennox S40] zone=${zoneId} hold armed via config/scheduleHold`);
      holdArmed = true;
    } catch (e) {
      this.log.warn(`[Lennox S40] config/scheduleHold failed: ${e.message}`);
    }

    if (!holdArmed) {
      try {
        await this.client.setScheduleHold(zoneId, sid, {
          hsp: period.hsp,
          csp: period.csp,
          type: "temporary",
          expirationMode: "nextPeriod",
        });
        this.log(`[Lennox S40] zone=${zoneId} hold armed via setScheduleHold`);
        holdArmed = true;
      } catch (e) {
        this.log.warn(`[Lennox S40] setScheduleHold failed: ${e.message}`);
      }
    }

    if (!holdArmed) {
      try {
        await this.client.setZoneHoldStatus(zoneId, {
          type: "temporary",
          expirationMode: "nextPeriod",
        });
        this.log(`[Lennox S40] zone=${zoneId} hold armed via status/hold`);
        holdArmed = true;
      } catch (e) {
        this.log.warn(`[Lennox S40] status/hold failed: ${e.message}`);
      }
    }

    try { await this.client.requestData(["/zones"]); } catch {}
    if (!holdArmed) this.log.warn("[Lennox S40] Hold may not be armed.");
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
          if (!Array.isArray(data.zones)) continue;

          for (const z of data.zones) {
            const zoneId = typeof z.id === "number" ? z.id : undefined;
            if (zoneId == null) continue;

            const schedHold = z.config && z.config.scheduleHold;
            if (schedHold && typeof schedHold.scheduleId === "number") {
              const existing = this.holdScheduleId.get(zoneId);
              if (existing !== schedHold.scheduleId) {
                this.holdScheduleId.set(zoneId, schedHold.scheduleId);
                this.log(`[Lennox S40] zone=${zoneId} hold scheduleId -> ${schedHold.scheduleId}`);
              }
            }

            const acc = this.zoneAccessories.get(zoneId);
            if (acc && z.status) acc.applyZoneStatus(z.status);
          }
        }
      } catch (e) {
        this.log.warn(`[Lennox S40] Retrieve error: ${e.message}`);
        try { await this.client.connect(); } catch {}
        try { await this.client.connectEndpoint(); } catch {}
        await new Promise((r) => setTimeout(r, backoff * 1000));
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LennoxS40Platform);
};
