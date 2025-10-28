// index.js
//
// Homebridge platform for Lennox S40.
//
// Reliable setpoint writes:
//  1) Write the hold schedule’s period 0 with {hsp,csp}
//  2) Arm a temporary hold pointing at that schedule (try multiple paths)
//  3) Nudge /zones so UI updates quickly

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

    // cache: zoneId -> hold scheduleId (default 32 + zoneId)
    this.holdScheduleId = new Map();
    for (const zid of this.zoneIds) this.holdScheduleId.set(zid, 32 + zid);

    // === NEW: remember cached accessories Homebridge restores on boot ===
    this.cachedAccessories = new Map(); // UUID -> accessory

    api.on("didFinishLaunching", async () => {
      try {
        // === NEW: adopt/prune before we start talking to the S40 ===
        this.adoptOrCreateAccessories();
        this.pruneStaleAccessories();

        await this.client.connect();
        await this.client.connectEndpoint();
        await this.client.requestData(["/devices", "/equipments", "/zones"]);

        this.startPump();
      } catch (e) {
        this.log.error(`[LennoxS40] Startup failed: ${e.message}`);
      }
    });
  }

  // === NEW: Homebridge calls this with each cached accessory on boot
  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  // === NEW: consistent UUID builder (must match accessory.js UUID_NS)
  zoneUuid(zoneId) {
    return this.api.hap.uuid.generate(`lennox-s40-zone:${zoneId}`);
  }

  // === NEW: create or adopt one accessory per configured zone
  adoptOrCreateAccessories() {
    const toRegister = [];
    for (const zoneId of this.zoneIds) {
      const uuid = this.zoneUuid(zoneId);
      const cached = this.cachedAccessories.get(uuid);

      if (cached) {
        // Adopt cached
        this.log(`[LennoxS40] adopting cached accessory for zone ${zoneId}`);
        const acc = new LennoxZoneAccessory(this, zoneId);  // creates a new "wrapper"
        // Use the cached platformAccessory instead of creating a new one:
        acc.accessory = cached;
        acc.service =
          cached.getService(this.Service.Thermostat) ||
          cached.addService(this.Service.Thermostat, `Lennox S40 Zone ${zoneId}`);
        this.zoneAccessories.set(zoneId, acc);
      } else {
        // Create new
        const acc = new LennoxZoneAccessory(this, zoneId);
        this.zoneAccessories.set(zoneId, acc);
        toRegister.push(acc.accessory);
      }
    }

    if (toRegister.length) {
      this.api.registerPlatformAccessories(
        "homebridge-lennox-s40",
        "LennoxS40Platform",
        toRegister
      );
    }
  }

  // === NEW: unregister anything cached that we don't manage now
  pruneStaleAccessories() {
    const wanted = new Set(this.zoneIds.map((zid) => this.zoneUuid(zid)));
    const toUnregister = [];

    for (const [uuid, acc] of this.cachedAccessories.entries()) {
      if (!wanted.has(uuid)) {
        toUnregister.push(acc);
      }
    }

    if (toUnregister.length) {
      this.log(`[LennoxS40] pruning ${toUnregister.length} stale cached accessory(ies)`);
      this.api.unregisterPlatformAccessories(
        "homebridge-lennox-s40",
        "LennoxS40Platform",
        toUnregister
      );
    }
  }

  // Central helper used by accessories to write setpoints
  // Sequence:
  //  1) Write hold schedule period 0
  //  2) Arm hold (try config->enabled, then setScheduleHold, then status.hold)
  async setZoneSetpointsViaSchedule(zoneId, { hsp, csp }) {
    const sid = this.holdScheduleId.get(zoneId) ?? (32 + zoneId);
    const period = {};
    if (Number.isFinite(hsp)) period.hsp = Math.round(hsp);
    if (Number.isFinite(csp)) period.csp = Math.round(csp);

    // (1) Update the period first
    this.log(`[LennoxS40] zone=${zoneId} scheduleId=${sid} periodId=0 write -> ${JSON.stringify(period)}`);
    await this.client.setSchedulePeriod(sid, 0, period);

    await new Promise((r) => setTimeout(r, 150));

    // (2) Arm a temp hold that points at that schedule — try multiple ways
    let holdArmed = false;
    if (typeof this.client.setZoneConfigScheduleHold === "function") {
      try {
        await this.client.setZoneConfigScheduleHold(zoneId, {
          enabled: true,
          exceptionType: "hold",
          scheduleId: sid,
          expirationMode: "nextPeriod",
          expiresOn: "0"
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
          expirationMode: "nextPeriod"
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
          expirationMode: "nextPeriod"
        });
        this.log(`[LennoxS40] zone=${zoneId} armed hold via zones/status/hold`);
        holdArmed = true;
      } catch (e) {
        this.log.warn(`[LennoxS40] zones/status/hold failed: ${e.message}`);
      }
    }

    try { await this.client.requestData(["/zones"]); } catch {}

    if (!holdArmed) {
      this.log.warn("[LennoxS40] Hold might not be armed (no supported hold method succeeded).");
    }
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

          if (Array.isArray(data.zones)) {
            for (const z of data.zones) {
              const zoneId = typeof z.id === "number" ? z.id : undefined;
              if (zoneId == null) continue;

              // learn/refresh the hold schedule id
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
      } catch (e) {
        this.log.warn(`[LennoxS40] Retrieve error: ${e.message}`);
        try { await this.client.connect(); } catch {}
        try { await this.client.connectEndpoint(); } catch {}
        await new Promise((r) => setTimeout(r, backoff * 1000));
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform("LennoxS40Platform", LennoxS40Platform);
};