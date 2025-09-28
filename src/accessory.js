// accessory.js
//
// Basic zone accessory exposing Current Temp + separate Heat/Cool thresholds
// and routing setpoint writes through the platform’s schedule writer.
//

const UUID_NS = "lennox-s40-zone";

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

    // ——— Characteristics wiring ———
    // S40 runs Auto (heat and cool) most of the time; mirror that.
    this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.currentHKMode ?? this.Characteristic.TargetHeatingCoolingState.AUTO)
      .onSet(async (newVal) => {
        // Modes can still be written via zones/status/period — but you already do that elsewhere.
        // Here we only stage it and let your existing mode writer (if any) act.
        this.currentHKMode = newVal;
        this.log(`[Zone ${this.zoneId}] Target mode -> ${newVal} (mode write handled elsewhere if implemented)`);
      });

    this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => (typeof this.currentTempC === "number" ? this.currentTempC : 21.0));

    // Thresholds map to HSP/CSP in °C internally for HK; we keep F locally then convert.
    this.service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .onGet(() => this.fToC(this.currentHspF ?? 70))
      .onSet(async (cVal) => {
        const hspF = this.cToF(cVal);
        const cspF = this.currentCspF ?? 73;
        await this.pushSetpoints(hspF, cspF);
      });

    this.service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .onGet(() => this.fToC(this.currentCspF ?? 73))
      .onSet(async (cVal) => {
        const cspF = this.cToF(cVal);
        const hspF = this.currentHspF ?? 70;
        await this.pushSetpoints(hspF, cspF);
      });

    // Sane characteristic props for thresholds
    this.service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 4.5, maxValue: 32, minStep: 0.5 });
    this.service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 15.5, maxValue: 37, minStep: 0.5 });

    // Register with HB
    this.api.registerPlatformAccessories("homebridge-lennox-s40", "LennoxS40Platform", [this.accessory]);

    // Initial mirrors
    this.currentHKMode = this.Characteristic.TargetHeatingCoolingState.AUTO;
    this.currentTempC = 21.0;
    this.currentHspF = 70;
    this.currentCspF = 73;
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
  }

  // Push setpoints via platform (writes to schedule hold period 0)
  async pushSetpoints(hspF, cspF) {
    // Basic deadband guard (device enforces 3°F; mirror that)
    if (Number.isFinite(hspF) && Number.isFinite(cspF) && cspF - hspF < 3) {
      const fix = hspF + 3;
      this.log(`[Zone ${this.zoneId}] widening deadband: hsp=${hspF} -> keep, csp=${cspF} -> ${fix}`);
      cspF = fix;
    }

    try {
      await this.platform.setZoneSetpointsViaSchedule(this.zoneId, { hsp: Math.round(hspF), csp: Math.round(cspF) });
      this.log(`[Zone ${this.zoneId}] setpoints push OK (schedule) hsp=${hspF} csp=${cspF}`);
      // optimistically update locally; final truth will come from poller
      this.currentHspF = Math.round(hspF);
      this.currentCspF = Math.round(cspF);
      this.service.updateCharacteristic(this.Characteristic.HeatingThresholdTemperature, this.fToC(this.currentHspF));
      this.service.updateCharacteristic(this.Characteristic.CoolingThresholdTemperature, this.fToC(this.currentCspF));
    } catch (e) {
      this.log.error(`[Zone ${this.zoneId}] setpoints push FAILED: ${e.message}`);
      throw e;
    }
  }

  fToC(f) { return Math.round(((f - 32) * 5) / 9 * 2) / 2; } // round to 0.5C
  cToF(c) { return Math.round((c * 9) / 5 + 32); }
}

module.exports = { LennoxZoneAccessory };