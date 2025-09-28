// accessory.js
//
// Basic zone accessory exposing Current Temp + separate Heat/Cool thresholds
// and routing setpoint writes through the platform’s schedule writer.
// Adds a coalesced writer so rapid changes (and device echoes) don’t cause
// back-to-back writes like: {"hsp":69,"csp":78} then {"hsp":67,"csp":78}.
// Also reports CurrentRelativeHumidity from zones.status.humidity.
//

const UUID_NS = "lennox-s40-zone";

// === BEGIN: Coalesced writer helper ===
class CoalescedSetpointWriter {
  constructor(log, publishSetpoints, debounceMs = 350) {
    this.log = log;
    this.publishSetpoints = publishSetpoints;
    this.debounceMs = debounceMs;

    this.pending = null;      // { hspF, cspF } desired
    this.timer = undefined;
    this.lastPublished = null; // last values we believe the device has
    this.inFlight = null;      // values currently being sent
  }

  requestWrite(next) {
    this.pending = { ...next }; // stage the latest desired values
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.flush().catch(err => this.log('flush error %o', err)),
      this.debounceMs
    );
  }

  onDeviceEcho(update) {
    // Called when we parse device period {hsp,csp} from Retrieve
    const hasH = typeof update.hspF === 'number';
    const hasC = typeof update.cspF === 'number';
    if (!hasH && !hasC) return;

    if (this.inFlight &&
        (!hasH || update.hspF === this.inFlight.hspF) &&
        (!hasC || update.cspF === this.inFlight.cspF)) {
      // Treat as ACK for what we just sent
      this.lastPublished = { ...this.inFlight };
      this.inFlight = null;
      this.log('ack hsp=%s csp=%s', this.lastPublished.hspF, this.lastPublished.cspF);
      return;
    }

    // Track latest seen device state to avoid redundant publishes
    this.lastPublished = {
      hspF: hasH ? update.hspF : (this.lastPublished && this.lastPublished.hspF),
      cspF: hasC ? update.cspF : (this.lastPublished && this.lastPublished.cspF),
    };
  }

  async flush() {
    this.timer = undefined;
    if (!this.pending) return;

    // Skip if nothing changed vs the last known device state
    if (this.lastPublished &&
        this.pending.hspF === this.lastPublished.hspF &&
        this.pending.cspF === this.lastPublished.cspF) {
      this.log('no-op (unchanged) hsp=%d csp=%d', this.pending.hspF, this.pending.cspF);
      this.pending = null;
      return;
    }

    const toSend = this.pending;
    this.pending = null;
    this.inFlight = { ...toSend };

    this.log('publish setpoints hsp=%d csp=%d', toSend.hspF, toSend.cspF);
    await this.publishSetpoints(toSend);

    // Fallback in case echo is missed/slow
    this.lastPublished = { ...toSend };
  }
}
// === END: Coalesced writer helper ===

class LennoxZoneAccessory {
  constructor(platform, zoneId) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.hap = platform.api.hap;
    this.Service = platform.Service;
    this.Characteristic = platform.Characteristic;

    this.zoneId = zoneId;

    const uuid = this.api.hap.uuid.generate(`${UUID_NS}:${zoneId}`);
    const displayName = `Lennox S40 Zone ${zoneId}`;

    this.accessory = new this.api.platformAccessory(displayName, uuid);
    this.service = this.accessory.getService(this.Service.Thermostat)
      || this.accessory.addService(this.Service.Thermostat, displayName);

    // Initial mirrors / local cache
    this.currentHKMode = this.Characteristic.TargetHeatingCoolingState.AUTO;
    this.currentTempC = 21.0;
    this.currentHspF = 70;
    this.currentCspF = 73;
    this.currentHumPct = 0;

    // Coalesced writer (routes to platform schedule writer)
    this._writer = new CoalescedSetpointWriter(
      (m, ...a) => this.log(`[Zone ${this.zoneId}] ${m}`, ...a),
      async ({ hspF, cspF }) => {
        const h = Math.round(hspF);
        const c = Math.round(cspF);
        await this.platform.setZoneSetpointsViaSchedule(this.zoneId, { hsp: h, csp: c });
      },
      350
    );

    // ——— Characteristics wiring ———
    // S40 runs Auto (heat and cool); mirror that.
    this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.currentHKMode ?? this.Characteristic.TargetHeatingCoolingState.AUTO)
      .onSet(async (newVal) => {
        this.currentHKMode = newVal;
        this.log(`[Zone ${this.zoneId}] Target mode -> ${newVal} (mode write handled elsewhere if implemented)`);
      });

    this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => (typeof this.currentTempC === "number" ? this.currentTempC : 21.0));

    // Current relative humidity (% on the Thermostat tile)
    this.service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => (typeof this.currentHumPct === "number" ? this.currentHumPct : 0));

    // Thresholds map to HSP/CSP (HomeKit uses °C; cache in °F then convert)
    this.service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .onGet(() => this.fToC(this.currentHspF ?? 70))
      .onSet(async (cVal) => {
        // Deadband-enforcing setter: if user raises HSP too close to CSP,
        // bump CSP up to maintain >= 3°F gap and reflect it immediately in HK.
        const newHspF = this.cToF(cVal);
        let newCspF = this.currentCspF ?? 73;

        if (Number.isFinite(newHspF) && Number.isFinite(newCspF) && (newCspF - newHspF) < 3) {
          newCspF = newHspF + 3;
          // Move the *other* slider in the Home UI right away
          this.currentCspF = Math.round(newCspF);
          this.service.updateCharacteristic(
            this.Characteristic.CoolingThresholdTemperature,
            this.fToC(this.currentCspF)
          );
        }

        await this.pushSetpoints(newHspF, newCspF); // coalesced
      })
      .setProps({ minValue: 4.5, maxValue: 32, minStep: 0.5 });

    this.service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .onGet(() => this.fToC(this.currentCspF ?? 73))
      .onSet(async (cVal) => {
        // Deadband-enforcing setter: if user lowers CSP too close to HSP,
        // pull HSP down to maintain >= 3°F gap and reflect it immediately in HK.
        const newCspF = this.cToF(cVal);
        let newHspF = this.currentHspF ?? 70;

        if (Number.isFinite(newHspF) && Number.isFinite(newCspF) && (newCspF - newHspF) < 3) {
          newHspF = newCspF - 3;
          // Move the *other* slider in the Home UI right away
          this.currentHspF = Math.round(newHspF);
          this.service.updateCharacteristic(
            this.Characteristic.HeatingThresholdTemperature,
            this.fToC(this.currentHspF)
          );
        }

        await this.pushSetpoints(newHspF, newCspF); // coalesced
      })
      .setProps({ minValue: 15.5, maxValue: 37, minStep: 0.5 });

    // Register with HB
    this.api.registerPlatformAccessories("homebridge-lennox-s40", "LennoxS40Platform", [this.accessory]);
  }

  // Apply zone.status from the poller
  applyZoneStatus(status) {
    if (!status) return;

    // Temperature
    if (typeof status.temperatureC === "number") {
      this.currentTempC = status.temperatureC;
      this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentTempC);
    } else if (typeof status.temperature === "number") {
      // Fahrenheit fallback
      this.currentTempC = this.fToC(status.temperature);
      this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentTempC);
    }

    // Humidity (%), prefer integer from status.humidity
    if (typeof status.humidity === "number" && Number.isFinite(status.humidity)) {
      this.currentHumPct = Math.min(100, Math.max(0, Math.round(status.humidity)));
      this.service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.currentHumPct);
    }

    // Period setpoints (F/C both appear)
    const p = status.period || {};
    if (typeof p.hsp === "number") this.currentHspF = p.hsp;
    if (typeof p.csp === "number") this.currentCspF = p.csp;
    if (typeof p.hspC === "number") this.currentHspF = this.cToF(p.hspC);
    if (typeof p.cspC === "number") this.currentCspF = this.cToF(p.cspC);

    // Reflect thresholds back to HK in °C
    if (typeof this.currentHspF === "number") {
      this.service.updateCharacteristic(
        this.Characteristic.HeatingThresholdTemperature,
        this.fToC(this.currentHspF)
      );
    }
    if (typeof this.currentCspF === "number") {
      this.service.updateCharacteristic(
        this.Characteristic.CoolingThresholdTemperature,
        this.fToC(this.currentCspF)
      );
    }

    // Stable CurrentHeatingCoolingState from op/demand (sticky to avoid flicker)
    {
      const CHCS = this.Characteristic.CurrentHeatingCoolingState;
      const rawOp = (status.tempOperation || status.op || "").toString().toLowerCase();
      const demand = (typeof status.demand === "number") ? status.demand : undefined;
      const ambientF = (typeof status.temperature === "number")
        ? Math.round(status.temperature)
        : (typeof status.temperatureC === "number" ? Math.round(this.cToF(status.temperatureC)) : undefined);
      if (this.lastHKState === undefined) this.lastHKState = CHCS.OFF;
      let next = this.lastHKState;
      if (rawOp === "cooling") next = CHCS.COOL;
      else if (rawOp === "heating") next = CHCS.HEAT;
      else if (rawOp === "off") next = CHCS.OFF;
      else {
        if (typeof demand === "number") {
          if (demand >= 5) {
            if (Number.isFinite(ambientF) && Number.isFinite(this.currentHspF) && Number.isFinite(this.currentCspF)) {
              if (ambientF >= this.currentCspF) next = CHCS.COOL;
              else if (ambientF <= this.currentHspF) next = CHCS.HEAT;
            }
          } else {
            next = CHCS.OFF;
          }
        }
      }
      this.lastHKState = next;
      this.service.updateCharacteristic(CHCS, next);
    }

    // Feed device echo to writer so it treats it as an ACK / latest truth
    this._writer.onDeviceEcho({ hspF: this.currentHspF, cspF: this.currentCspF });
  }

  // Push setpoints (coalesced). Also updates local cache & HK immediately.
  async pushSetpoints(hspF, cspF) {
    // Basic deadband guard (device enforces 3°F; mirror that)
    if (Number.isFinite(hspF) && Number.isFinite(cspF) && cspF - hspF < 3) {
      const fixedCsp = hspF + 3;
      this.log(`[Zone ${this.zoneId}] widening deadband: hsp=${hspF} keep, csp=${cspF} -> ${fixedCsp}`);
      cspF = fixedCsp;
    }

    // Update local cache first so we never “revert” on the next write
    this.currentHspF = Math.round(hspF);
    this.currentCspF = Math.round(cspF);

    // Optimistically reflect to HomeKit (device truth will confirm via poller)
    this.service.updateCharacteristic(this.Characteristic.HeatingThresholdTemperature, this.fToC(this.currentHspF));
    this.service.updateCharacteristic(this.Characteristic.CoolingThresholdTemperature, this.fToC(this.currentCspF));

    // Ask the coalescer to publish (debounced & ACK-aware)
    this._writer.requestWrite({ hspF: this.currentHspF, cspF: this.currentCspF });
  }

  fToC(f) { return Math.round(((f - 32) * 5) / 9 * 2) / 2; } // round to 0.5C
  cToF(c) { return Math.round((c * 9) / 5 + 32); }
}

module.exports = { LennoxZoneAccessory };