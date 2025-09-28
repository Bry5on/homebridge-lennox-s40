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

    api.on("didFinishLaunching", async () => {
      try {
        await this.client.connect();
        await this.client.connectEndpoint();
        await this.client.requestData(["/devices", "/equipments", "/zones"]);

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
    // Fresh registration each launch; HB caches them.
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

    // tiny pause so S40 snapshots period before arming hold
    await new Promise((r) => setTimeout(r, 150));

    // (2) Arm a temp hold that points at that schedule — try multiple ways
    const desiredHold = {
      type: "temporary",
      expirationMode: "nextPeriod",
      scheduleId: sid,
      period, // some firmwares like the temps echoed here
    };

    // Try zones/config/scheduleHold.enabled=true
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

    // Fallback: zones/command/setScheduleHold
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

    // Last resort: zones/status/hold
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

    // Nudge for immediate UI refresh
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