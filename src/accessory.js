// accessory.js
// Zone thermostat. Adopts cached HAP accessories when UUID matches.

const UUID_NS = "lennox-s40-zone";

class CoalescedSetpointWriter {
  constructor(log, publishSetpoints, debounceMs = 350) {
    this.log = log;
    this.publishSetpoints = publishSetpoints;
    this.debounceMs = debounceMs;
    this.pending = null;
    this.timer = undefined;
    this.lastPublished = null;
    this.inFlight = null;
  }

  requestWrite(next) {
    this.pending = { ...next };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.flush().catch((err) => this.log("flush error %o", err)),
      this.debounceMs
    );
  }

  onDeviceEcho(update) {
    const hasH = typeof update.hspF === "number";
    const hasC = typeof update.cspF === "number";
    if (!hasH && !hasC) return;
    if (this.inFlight && (!hasH || update.hspF === this.inFlight.hspF) && (!hasC || update.cspF === this.inFlight.cspF)) {
      this.lastPublished = { ...this.inFlight };
      this.inFlight = null;
      this.log("ack hsp=%s csp=%s", this.lastPublished.hspF, this.lastPublished.cspF);
      return;
    }
    this.lastPublished = {
      hspF: hasH ? update.hspF : (this.lastPublished && this.lastPublished.hspF),
      cspF: hasC ? update.cspF : (this.lastPublished && this.lastPublished.cspF),
    };
  }

  async flush() {
    this.timer = undefined;
    if (!this.pending) return;
    if (this.lastPublished && this.pending.hspF === this.lastPublished.hspF && this.pending.cspF === this.lastPublished.cspF) {
      this.log("no-op (unchanged) hsp=%d csp=%d", this.pending.hspF, this.pending.cspF);
      this.pending = null;
      return;
    }
    const toSend = this.pending;
    this.pending = null;
    this.inFlight = { ...toSend };
    this.log("publish setpoints hsp=%d csp=%d", toSend.hspF, toSend.cspF);
    await this.publishSetpoints(toSend);
    this.lastPublished = { ...toSend };
  }
}

class LennoxZoneAccessory {
  constructor(platform, zoneId, cachedAccessory = null) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.hap = platform.api.hap;
    this.Service = platform.Service;
    this.Characteristic = platform.Characteristic;
    this.zoneId = zoneId;

    const uuid = this.api.hap.uuid.generate(`${UUID_NS}:${zoneId}`);
    const displayName = `Lennox S40 Zone ${zoneId}`;
    const adopted = cachedAccessory && cachedAccessory.UUID === uuid;
    this.accessory = adopted ? cachedAccessory : new this.api.platformAccessory(displayName, uuid);
    this.accessory.context.zoneId = this.zoneId;
    this.service = this.accessory.getService(this.Service.Thermostat)
      || this.accessory.addService(this.Service.Thermostat, displayName);

    this.ensureInfo();
    this.currentHKMode = this.Characteristic.TargetHeatingCoolingState.AUTO;
    this.currentTempC = 21.0;
    this.currentHspF = 70;
    this.currentCspF = 73;
    this.currentHumPct = 0;
    this.isActive = true;
    this.lastSeenAt = Date.now();

    this.service.getCharacteristic(this.Characteristic.StatusActive).onGet(() => this.isActive);
    this._aliveTimer = setInterval(() => {
      const active = Date.now() - this.lastSeenAt < 90_000;
      if (active !== this.isActive) {
        this.isActive = active;
        this.service.updateCharacteristic(this.Characteristic.StatusActive, this.isActive);
      }
    }, 30_000);

    this._mutingHK = false;
    this._withHKMute = (fn) => { this._mutingHK = true; try { fn(); } finally { this._mutingHK = false; } };

    this._writer = new CoalescedSetpointWriter(
      (m, ...a) => this.log(`[Zone ${this.zoneId}] ${m}`, ...a),
      async ({ hspF, cspF }) => {
        await this.platform.setZoneSetpointsViaSchedule(this.zoneId, { hsp: Math.round(hspF), csp: Math.round(cspF) });
      },
      350
    );

    this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.currentHKMode ?? this.Characteristic.TargetHeatingCoolingState.AUTO)
      .onSet(async (newVal) => {
        if (this._mutingHK) return;
        this.currentHKMode = newVal;
        this.log(`[Zone ${this.zoneId}] Target mode -> ${newVal} (mode write not in this PR)`);
      });

    this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => (typeof this.currentTempC === "number" ? this.currentTempC : 21.0));

    this.service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => (typeof this.currentHumPct === "number" ? this.currentHumPct : 0));

    this.service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .onGet(() => this.fToC(this.currentHspF ?? 70))
      .onSet(async (cVal) => {
        if (this._mutingHK) return;
        const newHspF = this.cToF(cVal);
        let newCspF = this.currentCspF ?? 73;
        if (Number.isFinite(newHspF) && Number.isFinite(newCspF) && newCspF - newHspF < 3) {
          newCspF = newHspF + 3;
          this.currentCspF = Math.round(newCspF);
          this._withHKMute(() => {
            this.service.updateCharacteristic(this.Characteristic.CoolingThresholdTemperature, this.fToC(this.currentCspF));
          });
        }
        await this.pushSetpoints(newHspF, newCspF);
      })
      .setProps({ minValue: 4.5, maxValue: 32, minStep: 0.5 });

    this.service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .onGet(() => this.fToC(this.currentCspF ?? 73))
      .onSet(async (cVal) => {
        if (this._mutingHK) return;
        const newCspF = this.cToF(cVal);
        let newHspF = this.currentHspF ?? 70;
        if (Number.isFinite(newHspF) && Number.isFinite(newCspF) && newCspF - newHspF < 3) {
          newHspF = newCspF - 3;
          this.currentHspF = Math.round(newHspF);
          this._withHKMute(() => {
            this.service.updateCharacteristic(this.Characteristic.HeatingThresholdTemperature, this.fToC(this.currentHspF));
          });
        }
        await this.pushSetpoints(newHspF, newCspF);
      })
      .setProps({ minValue: 15.5, maxValue: 37, minStep: 0.5 });

    if (adopted) {
      this.log(`[Zone ${this.zoneId}] Restoring cached accessory ${uuid}`);
      this.api.updatePlatformAccessories([this.accessory]);
    } else {
      this.log(`[Zone ${this.zoneId}] Registering new accessory ${uuid}`);
      this.api.registerPlatformAccessories("homebridge-lennox-s40", "LennoxS40Platform", [this.accessory]);
    }

    this.flushInfoToCache();
    setTimeout(() => this.ensureInfo(true), 1500);
    setTimeout(() => this.ensureInfo(true), 10_000);
  }

  applyZoneStatus(status) {
    if (!status) return;
    this.lastSeenAt = Date.now();
    if (!this.isActive) {
      this.isActive = true;
      this.service.updateCharacteristic(this.Characteristic.StatusActive, true);
    }
    if (typeof status.temperatureC === "number") {
      this.currentTempC = status.temperatureC;
      this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentTempC);
    } else if (typeof status.temperature === "number") {
      this.currentTempC = this.fToC(status.temperature);
      this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentTempC);
    }
    if (typeof status.humidity === "number" && Number.isFinite(status.humidity)) {
      this.currentHumPct = Math.min(100, Math.max(0, Math.round(status.humidity)));
      this.service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.currentHumPct);
    }
    const p = status.period || {};
    if (typeof p.hsp === "number") this.currentHspF = p.hsp;
    else if (typeof p.hspC === "number") this.currentHspF = this.cToF(p.hspC);
    if (typeof p.csp === "number") this.currentCspF = p.csp;
    else if (typeof p.cspC === "number") this.currentCspF = this.cToF(p.cspC);
    this._withHKMute(() => {
      if (typeof this.currentHspF === "number") {
        this.service.updateCharacteristic(this.Characteristic.HeatingThresholdTemperature, this.fToC(this.currentHspF));
      }
      if (typeof this.currentCspF === "number") {
        this.service.updateCharacteristic(this.Characteristic.CoolingThresholdTemperature, this.fToC(this.currentCspF));
      }
    });
    {
      const CHCS = this.Characteristic.CurrentHeatingCoolingState;
      const rawOp = (status.tempOperation || status.op || "").toString().toLowerCase();
      const demand = typeof status.demand === "number" ? status.demand : undefined;
      const ambientF = typeof status.temperature === "number"
        ? Math.round(status.temperature)
        : (typeof status.temperatureC === "number" ? Math.round(this.cToF(status.temperatureC)) : undefined);
      if (this.lastHKState === undefined) this.lastHKState = CHCS.OFF;
      let next = this.lastHKState;
      if (rawOp === "cooling") next = CHCS.COOL;
      else if (rawOp === "heating") next = CHCS.HEAT;
      else if (rawOp === "off") next = CHCS.OFF;
      else if (typeof demand === "number") {
        if (demand >= 5 && Number.isFinite(ambientF) && Number.isFinite(this.currentHspF) && Number.isFinite(this.currentCspF)) {
          if (ambientF >= this.currentCspF) next = CHCS.COOL;
          else if (ambientF <= this.currentHspF) next = CHCS.HEAT;
        } else next = CHCS.OFF;
      }
      this.lastHKState = next;
      this.service.updateCharacteristic(CHCS, next);
    }
    this._writer.onDeviceEcho({ hspF: this.currentHspF, cspF: this.currentCspF });
  }

  async pushSetpoints(hspF, cspF) {
    if (Number.isFinite(hspF) && Number.isFinite(cspF) && cspF - hspF < 3) {
      const fixedCsp = hspF + 3;
      this.log(`[Zone ${this.zoneId}] widening deadband: hsp=${hspF} keep, csp=${cspF} -> ${fixedCsp}`);
      cspF = fixedCsp;
    }
    this.currentHspF = Math.round(hspF);
    this.currentCspF = Math.round(cspF);
    this._withHKMute(() => {
      this.service.updateCharacteristic(this.Characteristic.HeatingThresholdTemperature, this.fToC(this.currentHspF));
      this.service.updateCharacteristic(this.Characteristic.CoolingThresholdTemperature, this.fToC(this.currentCspF));
    });
    this._writer.requestWrite({ hspF: this.currentHspF, cspF: this.currentCspF });
  }

  ensureInfo(reassert = false) {
    const info = this.accessory.getService(this.Service.AccessoryInformation)
      || this.accessory.addService(this.Service.AccessoryInformation);
    const realFw = (this.platform && this.platform.pluginVersion) || "0.0.0";
    info
      .setCharacteristic(this.Characteristic.Manufacturer, "Lennox")
      .setCharacteristic(this.Characteristic.Model, "S40 Thermostat")
      .setCharacteristic(this.Characteristic.SerialNumber, `zone-${this.zoneId}`);
    const FW = this.Characteristic.FirmwareRevision;
    const current = info.getCharacteristic(FW).value;
    if (!reassert && (current === undefined || current === null || current === "0" || current === 0)) {
      info.updateCharacteristic(FW, `${realFw}+boot`);
    }
    info.updateCharacteristic(FW, realFw);
  }

  flushInfoToCache() {
    const ctx = this.accessory.context || (this.accessory.context = {});
    ctx.manufacturer = "Lennox";
    ctx.model = "S40 Thermostat";
    ctx.serialNumber = `zone-${this.zoneId}`;
    ctx.firmwareRevision = (this.platform && this.platform.pluginVersion) || "0.0.0";
    try {
      this.api.updatePlatformAccessories([this.accessory]);
      this.log(`[Zone ${this.zoneId}] AccessoryInformation persisted (fw=${ctx.firmwareRevision})`);
    } catch (e) {
      this.log(`[Zone ${this.zoneId}] updatePlatformAccessories failed: ${e.message}`);
    }
  }

  fToC(f) { return Math.round(((f - 32) * 5) / 9 * 2) / 2; }
  cToF(c) { return Math.round((c * 9) / 5 + 32); }
}

module.exports = { LennoxZoneAccessory };
