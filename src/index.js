const { LccClient } = require("./lccClient");
const { LennoxZoneAccessory, zoneUuid } = require("./accessory");
const pkg = require("../package.json");

const PLUGIN_NAME = "homebridge-lennox-s40";
const PLATFORM_NAME = "LennoxS40Platform";
const LENNOX_HVAC = new Set(["off", "heat", "cool", "heat and cool"]);

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
    this.zoneScheduleId = new Map();
    for (const zid of this.zoneIds) this.holdScheduleId.set(zid, 32 + zid);

    this._pumpRunning = false;
    this._retrieveStartTime = 1;
    this._cursorAdvanced = false;

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

        this.adoptZones();
        try {
          await this.sessionStart(true);
        } catch (e) {
          this.log.warn(`[Lennox S40] Initial session failed: ${e.message}`);
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

  adoptZones() {
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
  }

  manualScheduleId(zoneId) {
    return 16 + Number(zoneId);
  }

  async sessionStart(resetCursor) {
    await this.client.connect();
    await this.client.connectEndpoint();
    await this.client.requestData(["/devices", "/equipments", "/zones"]);
    if (resetCursor) {
      this._retrieveStartTime = 1;
      this._cursorAdvanced = false;
    }
  }

  async setZoneHvacMode(zoneId, lennoxMode) {
    if (!LENNOX_HVAC.has(lennoxMode)) throw new Error(`unsupported HVAC mode: ${lennoxMode}`);
    const manual = this.manualScheduleId(zoneId);
    const current = this.zoneScheduleId.get(zoneId);

    if (current !== manual) {
      this.log(`[Lennox S40] zone=${zoneId} leaving schedule ${current ?? "unknown"} for manual ${manual} to set ${lennoxMode}`);
      await this.client.setZoneSchedule(zoneId, manual);
      this.zoneScheduleId.set(zoneId, manual);
      await new Promise((r) => setTimeout(r, 150));
    }

    this.log(`[Lennox S40] zone=${zoneId} systemMode -> ${lennoxMode} scheduleId=${manual}`);
    await this.client.setSchedulePeriod(manual, 0, { systemMode: lennoxMode });

    const hold = this.holdScheduleId.get(zoneId);
    if (typeof hold === "number" && hold !== manual) {
      try {
        await this.client.setSchedulePeriod(hold, 0, { systemMode: lennoxMode });
      } catch (e) {
        this.log.warn(`[Lennox S40] zone=${zoneId} hold schedule mode write failed: ${e.message}`);
      }
    }

    try { await this.client.requestData(["/zones"]); } catch {}
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

  applyMessages(msgs) {
    for (const m of msgs) {
      if (!m) continue;
      const data = m.Data || m.data;
      if (!data || !Array.isArray(data.zones)) continue;

      for (const z of data.zones) {
        const zoneId = typeof z.id === "number" ? z.id : undefined;
        if (zoneId == null) continue;

        if (z.config && typeof z.config.scheduleId === "number") {
          this.zoneScheduleId.set(zoneId, z.config.scheduleId);
        }

        const schedHold = z.config && z.config.scheduleHold;
        if (schedHold && typeof schedHold.scheduleId === "number") {
          const existing = this.holdScheduleId.get(zoneId);
          if (existing !== schedHold.scheduleId) {
            this.holdScheduleId.set(zoneId, schedHold.scheduleId);
            this.log(`[Lennox S40] zone=${zoneId} hold scheduleId -> ${schedHold.scheduleId}`);
          }
        }

        const acc = this.zoneAccessories.get(zoneId);
        if (acc && z.status) acc.applyZoneStatus(z.status, z.config);
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
          if (nextStartTime != null && nextStartTime > this._retrieveStartTime) {
            this._retrieveStartTime = nextStartTime;
            this._cursorAdvanced = true;
          } else if (!this._cursorAdvanced) {
            this.log.debug("[Lennox S40] Retrieve had no timestamp; cursor stays put so a reconnect can replay current state.");
          }
        }
      } catch (e) {
        this.log.warn(`[Lennox S40] Retrieve error: ${e.message}`);
        try {
          await this.sessionStart(false);
          this.log("[Lennox S40] Session re-established; RequestData re-issued.");
        } catch (re) {
          this.log.warn(`[Lennox S40] Reconnect failed: ${re.message}`);
        }
        await new Promise((r) => setTimeout(r, backoff * 1000));
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LennoxS40Platform);
};
